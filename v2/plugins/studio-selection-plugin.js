/* Studio's local Draw.io embed bridge. Loaded from the pinned local bundle. */
(function () {
  // bootstrap.js loads app.min.js asynchronously, so this script may run before Draw exists.
  // Register as soon as the documented plugin entry point appears; it also invokes plugins
  // immediately when the UI has already been created.
  var attempts = 0;
  function register() {
    if (!window.Draw || typeof window.Draw.loadPlugin !== "function") {
      attempts += 1;
      if (attempts < 600) window.setTimeout(register, 50);
      else console.error("[studio-drawio-bridge] Timed out waiting for Draw.loadPlugin");
      return;
    }
    window.Draw.loadPlugin(function (ui) {
    var graph = ui && ui.editor && ui.editor.graph;
    var model = graph && graph.getModel && graph.getModel();
    var currentGraph = function () { return ui && ui.editor && ui.editor.graph || graph; };
    if (!graph || !model || typeof graph.getSelectionModel !== "function") {
      console.error("[studio-drawio-bridge] Native graph model is unavailable");
      return;
    }

    var originalBackground;
    var hasOriginalBackground = false;
    // Cells created during an atomic batch are tracked for rollback.
    var activeBatchCreatedCells = null;
    var studioParentOrigin = "";
    var pendingBridgeReadyMessage = null;
    var bridgeHelloTimer = null;
    var publish = function (message) {
      if (!studioParentOrigin) return;
      window.parent.postMessage(JSON.stringify(message), studioParentOrigin);
    };
    var requestStudioHandshake = function () {
      if (studioParentOrigin) {
        if (bridgeHelloTimer !== null) window.clearInterval(bridgeHelloTimer);
        bridgeHelloTimer = null;
        return;
      }
      // The hello has no sensitive content. Studio validates event.source and event.origin,
      // then replies to this exact Draw.io origin; only that welcome can lock the parent origin.
      window.parent.postMessage(JSON.stringify({ event: "studioDrawioHello" }), "*");
      if (bridgeHelloTimer === null) {
        bridgeHelloTimer = window.setInterval(function () {
          if (studioParentOrigin) {
            window.clearInterval(bridgeHelloTimer);
            bridgeHelloTimer = null;
            return;
          }
          window.parent.postMessage(JSON.stringify({ event: "studioDrawioHello" }), "*");
        }, 250);
      }
    };
    var currentPageId = function () {
      var page = ui.currentPage;
      var id = page && (typeof page.getId === "function" ? page.getId() : page.id);
      return typeof id === "string" && id ? id : null;
    };

    // Diagram styles are explicit native-document mutations. They never change the parent
    // application's CSS theme or the background/grid of the Draw.io page.
    var activeDiagramStyle = null;
    var activeDiagramStyleEnabled = false;
    var patchedStyleGraphs = typeof WeakSet === "function" ? new WeakSet() : null;
    var styleColorProperties = ["fillColor", "strokeColor", "fontColor", "gradientColor", "swimlaneFillColor",
      "separatorColor", "indicatorColor", "labelBackgroundColor", "labelBorderColor"];
    var styleManagedProperties = styleColorProperties.concat(["strokeWidth", "dashed", "dashPattern", "startArrow",
      "endArrow", "rounded", "shadow", "opacity", "fontFamily", "fontSize", "fontStyle", "align",
      "verticalAlign", "spacing", "glass", "comic"]);
    var styleCategories = ["node", "service", "database", "user", "external", "container", "edge", "edgeDashed", "edgeDotted"];

    function stylePairs(styleText) {
      var pairs = [];
      String(styleText || "").split(";").filter(Boolean).forEach(function (entry) {
        var at = entry.indexOf("=");
        pairs.push(at < 0 ? { key: entry, value: "" } : { key: entry.slice(0, at), value: entry.slice(at + 1) });
      });
      return pairs;
    }
    function classifyStyleCell(cell, styleText, activeModel) {
      if (cell && cell.edge) {
        if (/(?:^|;)dashed=1(?:;|$)/.test(styleText) && /(?:^|;)dashPattern=1(?:\\s|;)/.test(styleText)) return "edgeDotted";
        if (/(?:^|;)dashed=1(?:;|$)/.test(styleText) || /(?:^|;)dashPattern=/.test(styleText)) return "edgeDashed";
        return "edge";
      }
      if (!cell || !cell.vertex) return null;
      var shapeMatch = /(?:^|;)shape=([^;]+)/.exec(styleText);
      var shape = (shapeMatch && shapeMatch[1] || "").toLowerCase();
      if (/(database|cylinder|datastore|data[-_]?store|rds|dynamodb|sql)/.test(shape)) return "database";
      if (/(actor|person|user|human)/.test(shape)) return "user";
      if (/(external|cloud|internet|outside)/.test(shape)) return "external";
      var children = 0;
      try { children = activeModel && activeModel.getChildCount ? activeModel.getChildCount(cell) : (cell.children || []).length; } catch (_) {}
      if (children > 0 || /(swimlane|partialrectangle|boundary|group|c4\\.container)/.test(shape) || /(?:^|;)swimlane=1(?:;|$)/.test(styleText)) return "container";
      if (/(server|service|microservice|compute|lambda|ec2|ecs|application)/.test(shape)) return "service";
      return "node";
    }
    function rewriteStyleForCell(styleText, category, targetStyle) {
      var colorsOnly = !targetStyle;
      var remove = colorsOnly ? styleColorProperties : styleManagedProperties;
      var retained = stylePairs(styleText).filter(function (pair) { return remove.indexOf(pair.key) < 0; });
      if (colorsOnly) return retained.map(function (pair) { return pair.value ? pair.key + "=" + pair.value : pair.key; }).join(";");
      var generic = category.indexOf("edge") === 0 ? (targetStyle.categories.edge || {}) : (targetStyle.categories.node || {});
      var specific = targetStyle.categories[category] || {};
      var resolved = {};
      Object.keys(generic).forEach(function (key) { resolved[key] = generic[key]; });
      Object.keys(specific).forEach(function (key) { resolved[key] = specific[key]; });
      Object.keys(resolved).forEach(function (key) {
        var at = -1;
        for (var i = 0; i < retained.length; i++) if (retained[i].key === key) { at = i; break; }
        if (at >= 0) retained.splice(at, 1);
        retained.push({ key: key, value: String(resolved[key]) });
      });
      return retained.map(function (pair) { return pair.value ? pair.key + "=" + pair.value : pair.key; }).join(";");
    }
    function validateDiagramStyle(style) {
      if (style == null) return null;
      if (!style || typeof style !== "object" || typeof style.id !== "string" ||
          !/^[a-z][a-z0-9-]{1,63}$/.test(style.id) || style.id === "original" ||
          typeof style.name !== "string" || style.name.length > 80 ||
          style.version !== 1 || !style.categories || typeof style.categories !== "object") {
        throw new Error("The diagram style definition is invalid.");
      }
      var allowed = styleManagedProperties;
      Object.keys(style.categories).forEach(function (category) {
        if (styleCategories.indexOf(category) < 0 || !style.categories[category] || typeof style.categories[category] !== "object") {
          throw new Error("Unsupported diagram style category: " + category);
        }
        Object.keys(style.categories[category]).forEach(function (property) {
          var value = style.categories[category][property];
          if (allowed.indexOf(property) < 0 || typeof value !== "string" || !value.trim() || value.length > 120 ||
              /[;<>\\u0000-\\u001f]/.test(value) || /url\\s*\\(|javascript:/i.test(value)) {
            throw new Error("Invalid diagram style value for " + property);
          }
        });
      });
      if (!style.categories.node || !style.categories.edge) throw new Error("The diagram style must define node and edge categories.");
      return style;
    }
    function styleForNewCell(cell, styleText, targetStyle, activeModel) {
      var category = classifyStyleCell(cell, styleText, activeModel);
      return category ? rewriteStyleForCell(styleText, category, targetStyle) : styleText;
    }
    function installStyleAwareGraphOperations(activeGraph) {
      if (!activeGraph || !activeDiagramStyleEnabled || !patchedStyleGraphs || patchedStyleGraphs.has(activeGraph)) return;
      patchedStyleGraphs.add(activeGraph);
      if (typeof activeGraph.insertVertex === "function") {
        var nativeInsertVertex = activeGraph.insertVertex;
        activeGraph.insertVertex = function () {
          var args = Array.prototype.slice.call(arguments);
          var originalStyle = String(args[7] || "");
          args[7] = styleForNewCell({ vertex: true, edge: false }, originalStyle, activeDiagramStyle,
            typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model);
          return nativeInsertVertex.apply(this, args);
        };
      }
      if (typeof activeGraph.insertEdge === "function") {
        var nativeInsertEdge = activeGraph.insertEdge;
        activeGraph.insertEdge = function () {
          var args = Array.prototype.slice.call(arguments);
          var originalStyle = String(args[5] || "");
          args[5] = styleForNewCell({ vertex: false, edge: true }, originalStyle, activeDiagramStyle,
            typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model);
          return nativeInsertEdge.apply(this, args);
        };
      }
      // Drag/drop and paste commonly go through addCells rather than insertVertex/insertEdge.
      // Style the cloned cell objects before Draw.io inserts them, keeping creation and styling
      // inside the same native undoable edit.
      if (typeof activeGraph.addCells === "function") {
        var nativeAddCells = activeGraph.addCells;
        activeGraph.addCells = function (cells) {
          var activeModel = typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model;
          function styleTree(cell) {
            if (!cell) return;
            if ((cell.vertex || cell.edge) && cell.id !== "0" && cell.id !== "1") {
              cell.style = styleForNewCell(cell, String(cell.style || ""), activeDiagramStyle, activeModel);
            }
            var children = cell.children || [];
            for (var index = 0; index < children.length; index++) styleTree(children[index]);
          }
          if (Array.isArray(cells)) cells.forEach(styleTree);
          return nativeAddCells.apply(this, arguments);
        };
      }
    }
    function collectStyleCells(activeModel) {
      var result = [];
      var root = activeModel && activeModel.getRoot ? activeModel.getRoot() : null;
      if (!root) throw new Error("The active Draw.io model has no root cell.");
      var stack = [root];
      var visited = typeof Set === "function" ? new Set() : null;
      var count = 0;
      while (stack.length) {
        var parent = stack.pop();
        if (!parent || (visited && visited.has(parent))) continue;
        if (visited) visited.add(parent);
        if (++count > 20000) throw new Error("The active page exceeds the 20,000-cell style operation limit.");
        var childCount = activeModel.getChildCount(parent);
        for (var i = childCount - 1; i >= 0; i--) {
          var cell = activeModel.getChildAt(parent, i);
          if (!cell) continue;
          if (cell.id !== "0" && cell.id !== "1" && (cell.vertex || cell.edge)) result.push(cell);
          stack.push(cell);
        }
      }
      return result;
    }
    function applyDiagramStyleRequest(request) {
      var targetStyle = validateDiagramStyle(request.style || null);
      var activeGraph = currentGraph();
      var activeModel = typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model;
      var changed = 0;
      var previousStyle = activeDiagramStyle;
      var previousStyleEnabled = activeDiagramStyleEnabled;
      activeDiagramStyle = targetStyle;
      activeDiagramStyleEnabled = true;
      installStyleAwareGraphOperations(activeGraph);
      if (request.apply !== true) {
        publish({ event: "studioDiagramStyleResult", requestId: request.requestId, success: true, applied: false, styleId: targetStyle ? targetStyle.id : "original" });
        return;
      }
      var originals = [];
      activeModel.beginUpdate();
      try {
        var cells = collectStyleCells(activeModel);
        cells.forEach(function (cell) {
          var previous = String(activeModel.getStyle(cell) || "");
          var category = classifyStyleCell(cell, previous, activeModel);
          if (!category) return;
          var next = rewriteStyleForCell(previous, category, targetStyle);
          if (next === previous) return;
          originals.push({ cell: cell, style: previous });
          activeModel.setStyle(cell, next || null);
          changed++;
        });
      } catch (error) {
        for (var i = originals.length - 1; i >= 0; i--) {
          try { activeModel.setStyle(originals[i].cell, originals[i].style || null); } catch (_) {}
        }
        activeDiagramStyle = previousStyle;
        activeDiagramStyleEnabled = previousStyleEnabled;
        throw error;
      } finally {
        activeModel.endUpdate();
      }
      if (changed > 0) {
        if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
        if (activeGraph && typeof activeGraph.refresh === "function") activeGraph.refresh();
      }
      publish({ event: "studioDiagramStyleResult", requestId: request.requestId, success: true,
        applied: true, styleId: targetStyle ? targetStyle.id : "original", changedCells: changed,
        pageId: currentPageId() });
    }
    var publishSelection = function () {
      var selectedGraph = currentGraph();
      var cells = typeof selectedGraph.getSelectionCells === "function" ? selectedGraph.getSelectionCells() : [];
      var cell = cells && cells.length ? cells[0] : null;
      var id = cell && (typeof cell.getId === "function" ? cell.getId() : cell.id);
      publish({
        event: "studioSelectionChanged",
        cellId: typeof id === "string" && id ? id : null,
        pageId: currentPageId()
      });
    };

    function runtimeMethods(target, preferred) {
      if (!target) return [];
      // Probe only the curated contract names instead of enumerating every prototype/getter.
      // This avoids invoking incidental accessors and keeps inspection bounded on large graphs.
      var names = [];
      (preferred || []).forEach(function (name) {
        try {
          if (names.indexOf(name) < 0 && typeof target[name] === "function") names.push(name);
        } catch (_) {}
      });
      // Never dump the full mxGraph API (over a thousand methods) into the model context.
      return names;
    }

    var requiredRuntimeCapabilities = {
      graph: ["getModel", "getDefaultParent", "getChildCells", "setCellStyles", "insertVertex", "insertEdge", "removeCells", "refresh", "convertValueToString"],
      model: ["getRoot", "getChildCount", "getChildAt", "getCell", "getStyle", "setStyle", "setValue", "setGeometry", "setTerminal", "beginUpdate", "endUpdate"],
      view: ["getState", "validate"]
    };

    function inspectShapeCapabilities(candidate) {
      var requested = [];
      if (Array.isArray(candidate)) {
        candidate.slice(0, 160).forEach(function (name) {
          if (requested.length >= 40 || typeof name !== "string" || name.length > 160 ||
              !/^[A-Za-z0-9_$:.-]{1,160}$/.test(name) ||
              name === "__proto__" || name === "constructor" || name === "prototype" ||
              requested.indexOf(name) >= 0) return;
          requested.push(name);
        });
      }
      var registered = {};
      var shapeRegistry = window.mxCellRenderer && window.mxCellRenderer.defaultShapes;
      requested.forEach(function (name) {
        var available = false;
        try {
          available = !!shapeRegistry &&
            Object.prototype.hasOwnProperty.call(shapeRegistry, name) &&
            typeof shapeRegistry[name] === "function";
        } catch (_) {}
        registered[name] = available;
      });
      return { requested: requested, registered: registered };
    }

    function buildCapabilityManifest(capabilities, jsShapeClassNames) {
      var required = {
        graph: requiredRuntimeCapabilities.graph.slice(),
        model: requiredRuntimeCapabilities.model.slice(),
        view: requiredRuntimeCapabilities.view.slice()
      };
      var missing = {};
      Object.keys(required).forEach(function (group) {
        var present = capabilities[group] || [];
        missing[group] = required[group].filter(function (name) { return present.indexOf(name) < 0; });
      });
      return {
        scriptSupported: Object.keys(missing).every(function (group) { return missing[group].length === 0; }),
        required: required,
        missing: missing,
        jsShapeClasses: inspectShapeCapabilities(jsShapeClassNames)
      };
    }

    function runtimeCellId(cell) {
      if (!cell) return null;
      var id = typeof cell.getId === "function" ? cell.getId() : cell.id;
      return typeof id === "string" && id ? id : null;
    }

    function runtimeCellLabel(cell, activeGraph) {
      try {
        if (activeGraph && typeof activeGraph.convertValueToString === "function") {
          var converted = activeGraph.convertValueToString(cell);
          if (typeof converted === "string") return converted.slice(0, 250);
        }
      } catch (_) {}
      var value = cell && cell.value;
      if (typeof value === "string") return value.slice(0, 250);
      if (value && value.nodeType === 1) {
        var label = value.getAttribute("label");
        if (label == null) label = value.getAttribute("value");
        return String(label == null ? value.textContent || "" : label).slice(0, 250);
      }
      return value == null ? "" : String(value).slice(0, 250);
    }

    function runtimePoints(points, limit) {
      if (!Array.isArray(points)) return [];
      return points.slice(0, limit).reduce(function (result, point) {
        if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) {
          result.push({ x: Number(point.x), y: Number(point.y) });
        }
        return result;
      }, []);
    }

    function runtimePointsCollinear(points) {
      if (!points || points.length < 3) return null;
      var first = points[0];
      var last = points[points.length - 1];
      var dx = last.x - first.x;
      var dy = last.y - first.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.0001) {
        return points.every(function (point) {
          return Math.abs(point.x - first.x) < 0.5 && Math.abs(point.y - first.y) < 0.5;
        });
      }
      return points.every(function (point) {
        return Math.abs(dx * (point.y - first.y) - dy * (point.x - first.x)) < 0.5;
      });
    }

    // A read-only snapshot of the live native runtime. The caller supplies the XML revision
    // and pinned bundle version; the active page ID is always read from Draw.io itself.
    function inspectDrawioRuntime(ui, activeGraph, activeModel, options) {
      options = options && typeof options === "object" ? options : {};
      var maxCells = Math.max(1, Math.min(60, Math.floor(Number(options.maxCells) || 60)));
      var maxRenderedEdges = Math.max(0, Math.min(24, Math.floor(Number(options.maxRenderedEdges) || 24)));
      var capabilities = {
        ui: runtimeMethods(ui, ["actions", "addListener", "getCurrentFile", "getCurrentPage"]),
        editor: runtimeMethods(ui && ui.editor, ["graph", "undoManager", "setModified", "execute"]),
        graph: runtimeMethods(activeGraph, ["getModel", "getDefaultParent", "getSelectionCells", "getChildCells", "insertVertex", "insertEdge", "setCellStyles", "removeCells", "groupCells", "ungroupCells", "alignCells", "refresh", "convertValueToString"]),
        model: runtimeMethods(activeModel, ["getRoot", "getChildCount", "getChildAt", "getCell", "getStyle", "setStyle", "setValue", "setGeometry", "setTerminal", "setVisible", "setCollapsed", "beginUpdate", "endUpdate", "add", "remove"]),
        view: runtimeMethods(activeGraph && activeGraph.view, ["getState", "validate", "validateBackground"]),
        vertexCell: [],
        edgeCell: []
      };
      var root = activeModel && typeof activeModel.getRoot === "function" ? activeModel.getRoot() : null;
      var allCells = [];
      var seenObjects = new Set();
      var stack = root ? [root] : [];
      var scannedParents = 0;
      var scanLimit = 10000;
      var vertexCount = 0;
      var edgeCount = 0;
      var scanTruncated = false;
      while (stack.length && scannedParents < scanLimit) {
        var parent = stack.pop();
        if (!parent || seenObjects.has(parent)) continue;
        seenObjects.add(parent);
        scannedParents++;
        var childCount = 0;
        try { childCount = typeof activeModel.getChildCount === "function" ? activeModel.getChildCount(parent) : 0; } catch (_) {}
        for (var childIndex = childCount - 1; childIndex >= 0; childIndex--) {
          var child = null;
          try { child = activeModel.getChildAt(parent, childIndex); } catch (_) {}
          if (!child || seenObjects.has(child)) continue;
          var childId = runtimeCellId(child);
          if (childId !== "0" && childId !== "1") {
            allCells.push(child);
            if (child.vertex) vertexCount++;
            if (child.edge) edgeCount++;
          }
          stack.push(child);
        }
      }
      if (stack.length) scanTruncated = true;
      var vertexSample = allCells.find(function (cell) { return cell && cell.vertex; });
      var edgeSample = allCells.find(function (cell) { return cell && cell.edge; });
      capabilities.vertexCell = runtimeMethods(vertexSample, ["getId", "getGeometry", "getStyle", "getValue", "isConnectable", "getTerminal"]);
      capabilities.edgeCell = runtimeMethods(edgeSample, ["getId", "getGeometry", "getStyle", "getValue", "getTerminal"]);
      function geometryOf(cell) {
        var geometry = cell && cell.geometry;
        if (!geometry) return null;
        var points = [];
        try {
          points = runtimePoints(geometry.points, 20);
        } catch (_) {}
        return {
          x: Number.isFinite(Number(geometry.x)) ? Number(geometry.x) : 0,
          y: Number.isFinite(Number(geometry.y)) ? Number(geometry.y) : 0,
          width: Number.isFinite(Number(geometry.width)) ? Number(geometry.width) : 0,
          height: Number.isFinite(Number(geometry.height)) ? Number(geometry.height) : 0,
          relative: geometry.relative === true,
          points: points
        };
      }
      function cellInfo(cell) {
        var style = "";
        try { style = activeModel && typeof activeModel.getStyle === "function" ? activeModel.getStyle(cell) : cell.style; } catch (_) {}
        var connectable = typeof cell.connectable === "boolean" ? cell.connectable : null;
        try {
          if (typeof cell.isConnectable === "function") {
            var isConnectable = cell.isConnectable();
            if (typeof isConnectable === "boolean") connectable = isConnectable;
          }
        } catch (_) {}
        var children = 0;
        try { children = typeof activeModel.getChildCount === "function" ? activeModel.getChildCount(cell) : 0; } catch (_) {}
        return {
          id: runtimeCellId(cell),
          parentId: runtimeCellId(cell.parent),
          kind: cell.vertex ? "vertex" : cell.edge ? "edge" : "cell",
          label: runtimeCellLabel(cell, activeGraph),
          style: typeof style === "string" ? style.slice(0, 400) : "",
          sourceId: runtimeCellId(cell.source),
          targetId: runtimeCellId(cell.target),
          connectable: connectable,
          visible: typeof cell.visible === "boolean" ? cell.visible : null,
          collapsed: typeof cell.collapsed === "boolean" ? cell.collapsed : null,
          childCount: Math.max(0, children),
          geometry: geometryOf(cell)
        };
      }
      var cells = allCells.slice(0, maxCells).map(cellInfo).filter(function (cell) { return !!cell.id; });
      var renderedEdges = [];
      if (activeGraph && activeGraph.view && typeof activeGraph.view.getState === "function" && maxRenderedEdges > 0) {
        allCells.filter(function (cell) { return cell && cell.edge; }).slice(0, maxRenderedEdges).forEach(function (edge) {
          var state = null;
          try { state = activeGraph.view.getState(edge); } catch (_) {}
          var points = runtimePoints(state && state.absolutePoints, 24);
          renderedEdges.push({
            id: runtimeCellId(edge),
            stateAvailable: !!state,
            absolutePoints: points,
            collinear: state && points.length >= 3 ? runtimePointsCollinear(points) : null
          });
        });
      }
      return {
        schemaVersion: 1,
        bridgeVersion: "studio-native-runtime/3",
        drawioVersion: typeof options.drawioVersion === "string" ? options.drawioVersion : "unknown",
        documentRevision: typeof options.documentRevision === "string" ? options.documentRevision : "",
        pageId: currentPageId(),
        capabilities: capabilities,
        capabilityManifest: buildCapabilityManifest(capabilities, options.jsShapeClassNames),
        counts: { cells: allCells.length, vertices: vertexCount, edges: edgeCount },
        cells: cells,
        renderedEdges: renderedEdges,
        truncated: scanTruncated || allCells.length > cells.length || edgeCount > renderedEdges.length
      };
    }

    function serializeScriptResult(value) {
      if (typeof value === "undefined") return { available: false, reason: "script_returned_undefined" };
      var ancestors = [];
      function copy(value, depth) {
        if (depth > 7) return "[Max depth]";
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "string") return value.slice(0, 4000);
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value !== "object") return "[" + typeof value + "]";
        if (value.nodeType && typeof value.nodeName === "string") {
          return { kind: "dom-node", nodeName: value.nodeName.slice(0, 80) };
        }
        if (ancestors.indexOf(value) >= 0) return "[Circular]";
        ancestors.push(value);
        var output;
        if (Array.isArray(value)) {
          output = value.slice(0, 100).map(function (item) { return copy(item, depth + 1); });
          if (value.length > 100) output.push("[Array truncated]");
        } else {
          var prototype = null;
          try { prototype = Object.getPrototypeOf(value); } catch (_) {}
          if (prototype !== Object.prototype && prototype !== null) {
            var className = "native-object";
            try { if (value.constructor && typeof value.constructor.name === "string") className = value.constructor.name.slice(0, 80); } catch (_) {}
            ancestors.pop();
            return { kind: "native-object", className: className };
          }
          output = {};
          Object.keys(value).slice(0, 80).forEach(function (key) {
            var descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) output[key.slice(0, 120)] = copy(descriptor.value, depth + 1);
          });
        }
        ancestors.pop();
        return output;
      }
      try {
        var copied = copy(value, 0);
        var encoded = JSON.stringify(copied);
        if (encoded.length > 16000) return { available: false, reason: "script_result_exceeds_16kib" };
        return { available: true, value: copied };
      } catch (_) {
        return { available: false, reason: "script_result_not_serializable" };
      }
    }

    function updateLabelMarkup(source, value) {
      if (typeof source !== "string" || !/<[a-z][^>]*>/i.test(source)) return value;
      var parsed = new DOMParser().parseFromString(source, "text/html");
      var container = parsed.body.firstElementChild;
      if (!container) return value;
      container.textContent = value;
      return container.outerHTML;
    }

    function applyNativeLayoutPlan(plan, activeGraph, activeModel) {
      function fail(message, rollbackConfirmed) {
        var error = new Error(message);
        error.rollbackConfirmed = rollbackConfirmed === true;
        throw error;
      }
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.expectedPageCellIds) ||
          !Array.isArray(plan.expectedCells) || !Array.isArray(plan.positions) || !Array.isArray(plan.edgeRoutes)) {
        fail("The Studio layout plan is malformed; nothing was changed.", true);
      }
      if (plan.engine !== "elk" && plan.engine !== "dagre") fail("Unsupported Studio layout engine.", true);
      if (!["layered", "mrtree", "radial", "stress", "force"].includes(plan.algorithm) ||
          !["RIGHT", "LEFT", "DOWN", "UP"].includes(plan.direction) ||
          (plan.engine === "dagre" && plan.algorithm !== "layered")) {
        fail("Unsupported Studio layout algorithm or direction.", true);
      }
      function boundedPlanNumber(value, min, max) {
        return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
      }
      if (!boundedPlanNumber(plan.nodeSpacing, 5, 500) || !boundedPlanNumber(plan.layerSpacing, 10, 800) ||
          !boundedPlanNumber(plan.iterations, 20, 3000) || !boundedPlanNumber(plan.randomSeed, 0, 100000) ||
          !Number.isInteger(plan.iterations) || !Number.isInteger(plan.randomSeed) ||
          !boundedPlanNumber(plan.margin, 0, 300) ||
          ["ORTHOGONAL", "POLYLINE", "SPLINES"].indexOf(plan.edgeRouting) < 0) {
        fail("The Studio layout plan contains invalid or out-of-range configuration values.", true);
      }
      if (typeof plan.documentRevision !== "string" || !/^[a-f0-9]{64}$/i.test(plan.documentRevision)) {
        fail("The Studio layout plan is not bound to a valid native XML revision.", true);
      }
      if (plan.positions.length < 1 || plan.positions.length > 5000 ||
          plan.expectedPageCellIds.length > 20000 || plan.expectedCells.length > 10000 ||
          plan.edgeRoutes.length > 10000) fail("The Studio layout plan exceeds native editor limits.", true);
      var livePageId = currentPageId();
      if ((plan.pageId || null) !== (livePageId || null)) {
        fail("The active Draw.io page changed after layout calculation. Recalculate layout before applying it.", true);
      }
      var root = activeModel.getRoot();
      var liveCells = [];
      var seenObjects = new Set();
      var stack = [root];
      while (stack.length) {
        var parent = stack.pop();
        if (!parent || seenObjects.has(parent)) continue;
        seenObjects.add(parent);
        liveCells.push(parent);
        var childCount = activeModel.getChildCount(parent);
        for (var index = childCount - 1; index >= 0; index--) {
          var child = activeModel.getChildAt(parent, index);
          if (child) stack.push(child);
        }
        if (liveCells.length > 20000) fail("The active page is too large for safe automatic layout.", true);
      }
      var liveById = Object.create(null);
      liveCells.forEach(function (cell) {
        var id = runtimeCellId(cell);
        if (id) liveById[id] = cell;
      });
      var expectedIds = plan.expectedPageCellIds.slice().map(String).sort();
      var liveIds = liveCells.map(runtimeCellId).filter(Boolean).sort();
      if (expectedIds.length !== liveIds.length ||
          expectedIds.some(function (id, index) { return id !== liveIds[index]; })) {
        fail("The native page's cell set changed while the layout was being calculated. No layout was applied.", true);
      }
      function near(actual, expected) {
        return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - Number(expected)) < 0.02;
      }
      plan.expectedCells.forEach(function (expected) {
        var cell = liveById[expected.cellId];
        if (!cell || !cell.geometry || runtimeCellId(cell.parent) !== expected.parentId) {
          fail("A layout target was deleted, moved to another parent, or lost its geometry: " + expected.cellId, true);
        }
        if (!near(cell.geometry.x, expected.x) || !near(cell.geometry.y, expected.y) ||
            !near(cell.geometry.width, expected.width) || !near(cell.geometry.height, expected.height)) {
          fail("Native geometry changed after layout calculation; no nodes were moved. Recalculate layout and retry.", true);
        }
        if (expected.kind === "edge" &&
            (runtimeCellId(cell.source) !== expected.sourceId || runtimeCellId(cell.target) !== expected.targetId)) {
          fail("A connector endpoint changed after layout calculation; no layout was applied.", true);
        }
        if (expected.kind === "vertex" && !cell.vertex) fail("A layout target is no longer a vertex: " + expected.cellId, true);
        if (expected.kind === "edge" && !cell.edge) fail("A layout target is no longer a connector: " + expected.cellId, true);
      });
      var positionsById = Object.create(null);
      plan.positions.forEach(function (item) {
        if (!item || typeof item.cellId !== "string" ||
            !Number.isFinite(item.x) || !Number.isFinite(item.y) ||
            Math.abs(item.x) > 1000000 || Math.abs(item.y) > 1000000 ||
            positionsById[item.cellId]) fail("The layout plan contains duplicate or invalid node coordinates.", true);
        var target = liveById[item.cellId];
        if (!target || !target.vertex || !target.geometry) fail("A layout plan references a missing vertex: " + item.cellId, true);
        positionsById[item.cellId] = { x: item.x, y: item.y };
      });
      if (Object.keys(positionsById).length !== plan.expectedCells.filter(function (item) { return item.kind === "vertex"; }).length) {
        fail("The layout plan does not contain every expected vertex exactly once.", true);
      }
      var routesById = Object.create(null);
      plan.edgeRoutes.forEach(function (route) {
        if (!route || typeof route.cellId !== "string" || !Array.isArray(route.points) || routesById[route.cellId]) {
          fail("The layout plan contains a duplicate or invalid connector route.", true);
        }
        if (!liveById[route.cellId] || !liveById[route.cellId].edge || !liveById[route.cellId].geometry) {
          fail("A layout plan references a missing connector: " + route.cellId, true);
        }
        if (route.points.length > 100 || route.points.some(function (point) {
          return !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
            Math.abs(point.x) > 1000000 || Math.abs(point.y) > 1000000;
        })) fail("The layout plan contains invalid connector waypoints.", true);
        routesById[route.cellId] = route.points;
      });
      var expectedEdgeIds = plan.expectedCells.filter(function (item) { return item.kind === "edge"; })
        .map(function (item) { return item.cellId; }).sort();
      var plannedEdgeIds = Object.keys(routesById).sort();
      if (expectedEdgeIds.length !== plannedEdgeIds.length ||
          expectedEdgeIds.some(function (id, index) { return id !== plannedEdgeIds[index]; })) {
        fail("The layout plan does not contain a route result for every targeted connector.", true);
      }

      var snapshots = plan.expectedCells.map(function (expected) {
        var cell = liveById[expected.cellId];
        return { cell: cell, geometry: cell.geometry.clone() };
      });
      var changedVertices = 0;
      var changedEdges = 0;
      activeModel.beginUpdate();
      try {
        plan.positions.forEach(function (item) {
          var cell = liveById[item.cellId];
          var geometry = cell.geometry.clone();
          geometry.x = item.x;
          geometry.y = item.y;
          activeModel.setGeometry(cell, geometry);
          changedVertices++;
        });
        plan.edgeRoutes.forEach(function (route) {
          var cell = liveById[route.cellId];
          var geometry = cell.geometry.clone();
          geometry.points = route.points.length ? route.points.map(function (point) {
            if (typeof window.mxPoint === "function") return new window.mxPoint(point.x, point.y);
            return { x: point.x, y: point.y };
          }) : null;
          activeModel.setGeometry(cell, geometry);
          changedEdges++;
        });
      } catch (mutationError) {
        var rollbackErrors = [];
        snapshots.forEach(function (snapshot) {
          try { activeModel.setGeometry(snapshot.cell, snapshot.geometry); }
          catch (rollbackError) { rollbackErrors.push(rollbackError && rollbackError.message ? String(rollbackError.message) : String(rollbackError)); }
        });
        fail("Studio auto layout failed while applying geometry: " +
          (mutationError && mutationError.message ? String(mutationError.message) : String(mutationError)) +
          (rollbackErrors.length ? "; geometry rollback was incomplete: " + rollbackErrors.join("; ") : "; prior geometry was restored."),
          rollbackErrors.length === 0);
      } finally {
        activeModel.endUpdate();
      }
      if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
      if (typeof activeGraph.refresh === "function") activeGraph.refresh();
      return { changedVertices: changedVertices, changedEdges: changedEdges, engine: plan.engine, algorithm: plan.algorithm };
    }

    function editCell(request) {
      // Draw.io can replace the active graph model when loading a new document.
      // Resolve it per request rather than retaining the model from plugin startup.
      var activeGraph = currentGraph();
      var activeModel = typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model;
      // mxGraphModel does not expose setConnectable in every Draw.io build.
      // Prefer a model/cell method when available; otherwise restore/set the native cell field.
      function setCellConnectable(cell, value) {
        if (!cell) throw new Error("Cannot change connectability on a missing cell");
        if (typeof activeModel.setConnectable === "function") {
          activeModel.setConnectable(cell, value);
        } else if (typeof cell.setConnectable === "function") {
          cell.setConnectable(value);
        } else {
          cell.connectable = value;
        }
      }
      var selectionOperation = String(request.path || "");
      var requestedPage = request.pageId;
      var activePage = currentPageId();
      if (requestedPage && activePage && requestedPage !== activePage) {
        throw new Error("The active Draw.io page changed before the edit");
      }
      if (request.cellId === "__batch__" && selectionOperation === "cell:batch") {
        var operations;
        try { operations = JSON.parse(String(request.value || "[]")); } catch (_) { throw new Error("Batch edit payload is not valid JSON"); }
        if (!Array.isArray(operations) || operations.length < 1 || operations.length > 50) throw new Error("A batch must contain between 1 and 50 operations");
        if (operations.some(function (operation) {
          return operation && (operation.path === "cell:execute-script" || operation.path === "cell:auto-layout");
        }) && operations.length !== 1) {
          throw new Error("A native Draw.io script or Studio auto-layout plan must be the only operation in its batch");
        }
        var allCells = [];
        var originalRoot = activeModel.getRoot();
        function collect(parent) {
          var count = activeModel.getChildCount(parent);
          for (var i = 0; i < count; i++) {
            var child = activeModel.getChildAt(parent, i);
            allCells.push(child);
            collect(child);
          }
        }
        collect(originalRoot);
        var originalTreeSnapshot = allCells.map(function (item) {
          return {
            cell: item,
            id: item && item.id,
            parent: item && item.parent,
            index: item && item.parent && typeof item.parent.getIndex === "function" ? item.parent.getIndex(item) : -1
          };
        });
        var originalCellsById = Object.create(null);
        allCells.forEach(function (item) { if (item && item.id) originalCellsById[item.id] = item; });
        var affectedIds = Object.create(null);
        var deletedIds = Object.create(null);
        var restoreAllIds = Object.create(null);
        var pathsById = Object.create(null);
        function markCellTree(cell) {
          if (!cell || cell.id === "0" || cell.id === "1" || deletedIds[cell.id]) return;
          affectedIds[cell.id] = true;
          deletedIds[cell.id] = true;
          restoreAllIds[cell.id] = true;
          var childCount = activeModel.getChildCount(cell);
          for (var childIndex = 0; childIndex < childCount; childIndex++) {
            markCellTree(activeModel.getChildAt(cell, childIndex));
          }
        }
        operations.forEach(function (operation) {
          if (!operation || typeof operation.cellId !== "string") return;
          if ((operation.path === "cell:execute-script" || operation.path === "cell:auto-layout") &&
              operation.cellId === "__active_page__") {
            allCells.forEach(function (item) {
              if (!item || item.id === "0" || item.id === "1") return;
              affectedIds[item.id] = true;
              restoreAllIds[item.id] = true;
              if (!pathsById[item.id]) pathsById[item.id] = [];
              pathsById[item.id].push("cell:execute-script");
            });
            return;
          }
          if (operation.path === "cell:delete") {
            // A delete can affect the entire cell tree and all incident edges.
            markCellTree(activeModel.getCell(operation.cellId));
          } else if (operation.cellId !== "0" && operation.cellId !== "1") {
            affectedIds[operation.cellId] = true;
            if (!pathsById[operation.cellId]) pathsById[operation.cellId] = [];
            pathsById[operation.cellId].push(operation.path);
          }
        });
        // Deleting a vertex can also remove its connected edges. Include only those edges
        // that a requested delete may affect; unrelated cells never participate in rollback.
        allCells.forEach(function (item) {
          if (item && item.edge &&
              ((item.source && deletedIds[item.source.id]) || (item.target && deletedIds[item.target.id]))) {
            affectedIds[item.id] = true;
            restoreAllIds[item.id] = true;
          }
        });
        var snapshots = allCells.filter(function (item) {
          return item && item.id !== "0" && item.id !== "1" && affectedIds[item.id];
        }).map(function (item) {
          return { cell: item, value: item.value && typeof item.value.cloneNode === "function" ? item.value.cloneNode(true) : item.value,
            style: item.style, geometry: item.geometry && item.geometry.clone(), source: item.source, target: item.target, parent: item.parent,
            index: item.parent && typeof item.parent.getIndex === "function" ? item.parent.getIndex(item) : -1,
            visible: item.visible, collapsed: item.collapsed, connectable: item.connectable,
            ownsConnectable: Object.prototype.hasOwnProperty.call(item, "connectable"),
            paths: (pathsById[item.id] || []).slice(), restoreAll: Boolean(restoreAllIds[item.id]) };
        });
        var batchResults = [];
        var batchScriptResult = null;
        var failedIndex = -1;
        var batchCreatedCells = [];
        var previousBatchCreatedCells = activeBatchCreatedCells;
        activeBatchCreatedCells = batchCreatedCells;
        activeModel.beginUpdate();
        try {
          operations.forEach(function (operation, index) {
            failedIndex = index;
            if (!operation || typeof operation.cellId !== "string" || typeof operation.path !== "string" ||
                typeof operation.value !== "string" || operation.path === "cell:batch" || operation.cellId === "__batch__" || operation.cellId === "__selection__") {
              throw new Error("Batch operation " + (index + 1) + " has an invalid or nested operation payload");
            }
            var operationResult = editCell({ cellId: operation.cellId, pageId: request.pageId, path: operation.path, value: operation.value });
            if (operation.path === "cell:execute-script") batchScriptResult = operationResult && operationResult.scriptResult || null;
            batchResults.push({ index: index + 1, cellId: operation.cellId, path: operation.path, value: operation.value, success: true });
          });
        } catch (error) {
          var rollbackErrors = [];
          var failedOperation = operations[failedIndex];
          batchResults.push({ index: failedIndex + 1, cellId: failedOperation && failedOperation.cellId || null,
            path: failedOperation && failedOperation.path || null, value: failedOperation && failedOperation.value || null,
            success: false,
            error: (error && error.name ? String(error.name) + ": " : "") +
              (error && error.message ? String(error.message) : String(error)),
            stack: error && error.stack ? String(error.stack).slice(0, 8000) : null });
          for (var createdIndex = batchCreatedCells.length - 1; createdIndex >= 0; createdIndex--) {
            try {
              var createdCell = batchCreatedCells[createdIndex];
              if (createdCell && activeModel.getCell(createdCell.id) === createdCell) activeModel.remove(createdCell);
            } catch (createdRollbackError) {
              rollbackErrors.push({ cellId: batchCreatedCells[createdIndex] && batchCreatedCells[createdIndex].id || "created-cell",
                error: createdRollbackError && createdRollbackError.message ? String(createdRollbackError.message) : String(createdRollbackError) });
            }
          }
          var currentCellsAfterFailure = [];
          function collectCurrent(parent) {
            var count = activeModel.getChildCount(parent);
            for (var currentIndex = 0; currentIndex < count; currentIndex++) {
              var currentCell = activeModel.getChildAt(parent, currentIndex);
              currentCellsAfterFailure.push(currentCell);
              collectCurrent(currentCell);
            }
          }
          collectCurrent(activeModel.getRoot());
          for (var currentIndex = currentCellsAfterFailure.length - 1; currentIndex >= 0; currentIndex--) {
            var currentCell = currentCellsAfterFailure[currentIndex];
            if (!currentCell || currentCell.id === "0" || currentCell.id === "1" ||
                (originalCellsById[currentCell.id] && originalCellsById[currentCell.id] === currentCell)) continue;
            try {
              if (activeModel.getCell(currentCell.id) === currentCell) activeModel.remove(currentCell);
            } catch (scriptRollbackError) {
              rollbackErrors.push({ cellId: currentCell.id || "script-created-cell",
                error: scriptRollbackError && scriptRollbackError.message ? String(scriptRollbackError.message) : String(scriptRollbackError) });
            }
          }
          snapshots.forEach(function (snapshot) {
            try {
              var item = snapshot.cell;
              if (activeModel.getCell(item.id) !== item && snapshot.parent) {
                activeModel.add(snapshot.parent, item, snapshot.index >= 0 ? snapshot.index : activeModel.getChildCount(snapshot.parent));
              }
              var restoreAll = snapshot.restoreAll;
              var paths = snapshot.paths;
              var restoreValue = restoreAll || paths.indexOf("label") >= 0 || paths.some(function (part) { return part.indexOf("valueAttr:") === 0; });
              var restoreStyle = restoreAll || paths.indexOf("style") >= 0 || paths.indexOf("cell:execute-script") >= 0 || paths.some(function (part) { return part.indexOf("style:") === 0; });
              var restoreGeometry = restoreAll || paths.some(function (part) { return part.indexOf("geometry:") === 0 || part.indexOf("point:") === 0; });
              var restoreSource = restoreAll || paths.indexOf("cell:source") >= 0;
              var restoreTarget = restoreAll || paths.indexOf("cell:target") >= 0;
              if (restoreValue) activeModel.setValue(item, snapshot.value);
              if (restoreStyle) activeModel.setStyle(item, snapshot.style);
              if (restoreGeometry && snapshot.geometry) activeModel.setGeometry(item, snapshot.geometry);
              // Only edge cells own terminals. Restore only terminals the operation may change.
              if (item.edge && restoreSource) activeModel.setTerminal(item, snapshot.source || null, true);
              if (item.edge && restoreTarget) activeModel.setTerminal(item, snapshot.target || null, false);
              if ((restoreAll || paths.indexOf("cell:parent") >= 0) && snapshot.parent && item.parent !== snapshot.parent) {
                activeModel.add(snapshot.parent, item, snapshot.index >= 0 ? snapshot.index : activeModel.getChildCount(snapshot.parent));
              }
              if ((restoreAll || paths.indexOf("cell:visible") >= 0) && typeof snapshot.visible === "boolean") activeModel.setVisible(item, snapshot.visible);
              if ((restoreAll || paths.indexOf("cell:collapsed") >= 0) && typeof snapshot.collapsed === "boolean") activeModel.setCollapsed(item, snapshot.collapsed);
              if (restoreAll || paths.indexOf("cell:connectable") >= 0) {
                if (typeof snapshot.connectable === "boolean") setCellConnectable(item, snapshot.connectable);
                else if (snapshot.ownsConnectable) item.connectable = snapshot.connectable;
                else delete item.connectable;
              }
            } catch (rollbackError) {
              rollbackErrors.push({ cellId: snapshot.cell.id, error: rollbackError && rollbackError.message ? String(rollbackError.message) : String(rollbackError) });
            }
          });
          var failure = new Error("Batch rolled back after operation " + (failedIndex + 1) + " failed: " + (error && error.message ? error.message : String(error)));
          // Do not claim a clean rollback if a script detached the default layer, replaced
          // the root, changed cell IDs/order, or swapped the active Graph/Model. Those effects
          // exceed the regular mxCell property snapshot and require user recovery.
          var verifiedCellsAfterRollback = [];
          function collectVerified(parent) {
            var verifiedCount = activeModel.getChildCount(parent);
            for (var verifiedIndex = 0; verifiedIndex < verifiedCount; verifiedIndex++) {
              var verifiedCell = activeModel.getChildAt(parent, verifiedIndex);
              verifiedCellsAfterRollback.push(verifiedCell);
              collectVerified(verifiedCell);
            }
          }
          try {
            collectVerified(activeModel.getRoot());
          } catch (verificationError) {
            rollbackErrors.push({ cellId: "__active_page__", error: "Could not verify the native cell tree after rollback: " +
              (verificationError && verificationError.message ? String(verificationError.message) : String(verificationError)) });
          }
          var graphModelUnchanged = false;
          try {
            graphModelUnchanged = currentGraph() === activeGraph &&
              typeof activeGraph.getModel === "function" && activeGraph.getModel() === activeModel &&
              activeModel.getRoot() === originalRoot;
          } catch (_) {}
          if (!graphModelUnchanged) {
            rollbackErrors.push({ cellId: "__active_page__", error: "The active Graph, Model, or root changed during the script; snapshot rollback cannot confirm full restoration." });
          }
          var treeRestored = verifiedCellsAfterRollback.length === originalTreeSnapshot.length &&
            originalTreeSnapshot.every(function (snapshot, index) {
              var current = verifiedCellsAfterRollback[index];
              if (current !== snapshot.cell || current.id !== snapshot.id || current.parent !== snapshot.parent) return false;
              if (snapshot.index >= 0 && snapshot.parent && typeof snapshot.parent.getIndex === "function" &&
                  snapshot.parent.getIndex(current) !== snapshot.index) return false;
              return true;
            });
          if (!treeRestored) {
            rollbackErrors.push({ cellId: "__active_page__", error: "The native cell tree/order does not match its pre-script snapshot after rollback." });
          }
          failure.batchResults = batchResults;
          failure.failedIndex = failedIndex;
          failure.rollbackErrors = rollbackErrors;
          failure.batchRolledBack = rollbackErrors.length === 0;
          throw failure;
        } finally {
          activeBatchCreatedCells = previousBatchCreatedCells;
          activeModel.endUpdate();
        }
        if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
        if (typeof activeGraph.refresh === "function") activeGraph.refresh();
        return { batchResults: batchResults, scriptResult: batchScriptResult };
      }
      if (request.cellId === "__selection__" && /^(cell:align:|cell:distribute:|cell:group$|cell:ungroup$)/.test(selectionOperation)) {
        var selected = typeof activeGraph.getSelectionCells === "function" ? activeGraph.getSelectionCells().slice() : [];
        var vertices = selected.filter(function (item) { return item && item.vertex && item.geometry && item.id !== "0" && item.id !== "1"; });
        if (selectionOperation === "cell:group" || selectionOperation === "cell:ungroup") {
          if (selected.length < (selectionOperation === "cell:group" ? 2 : 1)) throw new Error("Select at least two cells to group, or a group to ungroup");
          activeModel.beginUpdate();
          try {
            if (selectionOperation === "cell:group") {
              if (typeof activeGraph.groupCells !== "function") throw new Error("This Draw.io build does not expose groupCells");
              activeGraph.groupCells(null, 0, selected);
            } else {
              var groups = selected.filter(function (item) { return item && item.vertex && activeModel.getChildCount(item) > 0; });
              if (!groups.length) throw new Error("Select a group cell to ungroup");
              if (typeof activeGraph.ungroupCells !== "function") throw new Error("This Draw.io build does not expose ungroupCells");
              activeGraph.ungroupCells(groups);
            }
          } finally { activeModel.endUpdate(); }
          if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
          if (typeof activeGraph.refresh === "function") activeGraph.refresh();
          return;
        }
        if (vertices.length < 2) throw new Error("Select at least two vertex cells to align or distribute");
        var alignMode = selectionOperation.slice("cell:align:".length);
        var distributeMode = selectionOperation.slice("cell:distribute:".length);
        var isAlign = selectionOperation.indexOf("cell:align:") === 0;
        if ((isAlign && ["left", "right", "top", "bottom", "center", "middle"].indexOf(alignMode) < 0) ||
            (!isAlign && ["horizontal", "vertical"].indexOf(distributeMode) < 0)) throw new Error("Unsupported selection layout operation");
        var parent = vertices[0].parent;
        if (vertices.some(function (item) { return item.parent !== parent; })) {
          throw new Error("Align and distribute only support cells in the same layer or group");
        }
        var snapshots = vertices.map(function (item) { return { cell: item, geometry: item.geometry.clone() }; });
        activeModel.beginUpdate();
        try {
          if (isAlign) {
            var bounds = vertices.map(function (item) { return item.geometry; });
            var left = Math.min.apply(Math, bounds.map(function (g) { return g.x; }));
            var top = Math.min.apply(Math, bounds.map(function (g) { return g.y; }));
            var right = Math.max.apply(Math, bounds.map(function (g) { return g.x + g.width; }));
            var bottom = Math.max.apply(Math, bounds.map(function (g) { return g.y + g.height; }));
            vertices.forEach(function (item) {
              var g = item.geometry.clone();
              if (alignMode === "left") g.x = left;
              else if (alignMode === "right") g.x = right - g.width;
              else if (alignMode === "top") g.y = top;
              else if (alignMode === "bottom") g.y = bottom - g.height;
              else if (alignMode === "center") g.x = left + (right - left - g.width) / 2;
              else g.y = top + (bottom - top - g.height) / 2;
              activeModel.setGeometry(item, g);
            });
          } else {
            var axis = distributeMode === "horizontal" ? "x" : "y";
            var extent = distributeMode === "horizontal" ? "width" : "height";
            var sorted = vertices.slice().sort(function (a, b) { return a.geometry[axis] - b.geometry[axis]; });
            var first = sorted[0].geometry[axis];
            var last = Math.max.apply(Math, sorted.map(function (item) { return item.geometry[axis] + item.geometry[extent]; }));
            var totalSize = sorted.reduce(function (sum, item) { return sum + item.geometry[extent]; }, 0);
            var gap = (last - first - totalSize) / (sorted.length - 1);
            if (!Number.isFinite(gap) || gap < 0) throw new Error("Selected cells do not have enough space for even distribution");
            var cursor = first;
            sorted.forEach(function (item) {
              var g = item.geometry.clone();
              g[axis] = cursor;
              activeModel.setGeometry(item, g);
              cursor += g[extent] + gap;
            });
          }
        } catch (error) {
          snapshots.forEach(function (snapshot) { activeModel.setGeometry(snapshot.cell, snapshot.geometry); });
          throw error;
        } finally { activeModel.endUpdate(); }
        if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
        if (typeof activeGraph.refresh === "function") activeGraph.refresh();
        return;
      }
      if (request.cellId === "__active_page__" && selectionOperation === "cell:auto-layout") {
        var layoutPlan;
        try { layoutPlan = JSON.parse(String(request.value || "null")); }
        catch (_) { throw new Error("Studio auto-layout plan is not valid JSON"); }
        if (!layoutPlan || layoutPlan.pageId !== (currentPageId() || null)) {
          throw new Error("The active Draw.io page changed after layout calculation. Re-run auto layout.");
        }
        return applyNativeLayoutPlan(layoutPlan, activeGraph, activeModel);
      }
      if (request.cellId === "__active_page__" && selectionOperation === "cell:execute-script") {
        var script = String(request.value || "");
        if (!script.trim()) throw new Error("The native Draw.io script is empty");
        if (script.length > 50000) throw new Error("The native Draw.io script exceeds 50000 characters");
        // This intentionally executes inside the local Draw.io iframe with the full native editor API.
        var executeNativeScript = new Function("ui", "editor", "graph", "model", "inspectRuntime", '"use strict";\n' + script);
        var scriptResult = executeNativeScript(ui, ui.editor, activeGraph, activeModel, function (options) {
          return inspectDrawioRuntime(ui, activeGraph, activeModel, options);
        });
        if (scriptResult && typeof scriptResult.then === "function") {
          throw new Error("Native Draw.io scripts must be synchronous; promise-returning scripts are not supported");
        }
        return {
          executed: true,
          resultType: scriptResult === null ? "null" : typeof scriptResult,
          scriptResult: serializeScriptResult(scriptResult)
        };
      }
      var cell = activeModel.getCell(request.cellId);
      if (!cell) throw new Error("Selected Draw.io cell no longer exists");
      var requestedPage = request.pageId;
      var activePage = currentPageId();
      if (requestedPage && activePage && requestedPage !== activePage) {
        throw new Error("The active Draw.io page changed before the property edit");
      }
      var path = String(request.path || "");
      var value = String(request.value == null ? "" : request.value);
      if (path === "cell:select") {
        if (cell.id === "0" || cell.id === "1") throw new Error("The Draw.io root and default layer cannot be selected as diagram elements");
        if (typeof activeGraph.setSelectionCell !== "function") throw new Error("This Draw.io build does not expose cell selection");
        activeGraph.setSelectionCell(cell);
        if (typeof activeGraph.scrollCellToVisible === "function") activeGraph.scrollCellToVisible(cell);
        return { selected: true, cellId: cell.id };
      }
      activeModel.beginUpdate();
      try {
        if (path === "label") {
          var current = cell.value;
          if (current && typeof current === "object" && current.nodeType === 1) {
            var next = current.cloneNode(true);
            var labelKey = next.hasAttribute("label") ? "label" : "value";
            next.setAttribute(labelKey, updateLabelMarkup(next.getAttribute(labelKey) || "", value));
            activeModel.setValue(cell, next);
          } else activeModel.setValue(cell, updateLabelMarkup(current, value));
        } else if (path === "style") {
          activeModel.setStyle(cell, value);
        } else if (path.indexOf("style:") === 0) {
          var key = path.slice(6);
          var styles = String(activeModel.getStyle(cell) || "").split(";").filter(Boolean);
          var found = false;
          var normalized = value.toLowerCase();
          var remove = value === "" || normalized === "0" || normalized === "false";
          var flag = normalized === "1" || normalized === "true";
          var nextStyles = styles.map(function (part) {
            var index = part.indexOf("=");
            var partKey = index > 0 ? part.slice(0, index) : part;
            if (partKey !== key) return part;
            found = true;
            return remove ? "" : flag ? key : key + "=" + value;
          }).filter(Boolean);
          if (!found && !remove) nextStyles.push(flag ? key : key + "=" + value);
          activeModel.setStyle(cell, nextStyles.join(";") + (nextStyles.length ? ";" : ""));
        } else if (path.indexOf("point:") === 0 && cell.geometry) {
          var parts = path.split(":");
          var index = Number(parts[1]);
          var axis = parts[2];
          var numeric = Number(value);
          var geometry = cell.geometry.clone();
          if (!Number.isInteger(index) || index < 0 || !Number.isFinite(numeric) || (axis !== "x" && axis !== "y")) {
            throw new Error("Connector control point coordinates must be numeric");
          }
          var points = (geometry.points || []).map(function (point) {
            return point && typeof point.clone === "function" ? point.clone() : Object.assign({}, point);
          });
          if (!points[index]) throw new Error("Connector control point no longer exists");
          points[index][axis] = numeric;
          geometry.points = points;
          activeModel.setGeometry(cell, geometry);
        } else if (path === "cell:add-node-after" || path === "cell:add-node-below") {
          if (!cell.vertex || !cell.geometry || cell.id === "0" || cell.id === "1") {
            throw new Error("The target must be a diagram vertex with geometry");
          }
          var addRequest;
          try { addRequest = JSON.parse(value); } catch (_) { throw new Error("New-node payload is not valid JSON"); }
          if (!addRequest || typeof addRequest.label !== "string" || !addRequest.label.trim() || addRequest.label.length > 500) {
            throw new Error("The new node needs a non-empty label of at most 500 characters");
          }
          var nodeParent = cell.parent;
          if (!nodeParent) throw new Error("The target has no parent container in the native Draw.io model");
          var nodeGeometry = cell.geometry;
          var sourceX = Number(nodeGeometry.x);
          var sourceY = Number(nodeGeometry.y);
          var newWidth = Number(nodeGeometry.width);
          var newHeight = Number(nodeGeometry.height);
          if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY) ||
              !Number.isFinite(newWidth) || newWidth <= 0 || !Number.isFinite(newHeight) || newHeight <= 0) {
            throw new Error("The target does not have usable coordinates and geometry to derive the new node placement");
          }
          var gridSpacing = Number(activeGraph.gridSize);
          if (!Number.isFinite(gridSpacing) || gridSpacing < 0) {
            throw new Error("Draw.io grid spacing is unavailable; use the native script path to choose an explicit placement");
          }
          var newX = path === "cell:add-node-after" ? sourceX + newWidth + gridSpacing : sourceX;
          var newY = path === "cell:add-node-after" ? sourceY : sourceY + newHeight + gridSpacing;
          // Omit the style argument so Draw.io applies its own default vertex style.
          var insertedNode = activeGraph.insertVertex(nodeParent, null, addRequest.label, newX, newY, newWidth, newHeight);
          if (!insertedNode) throw new Error("Draw.io did not create the new vertex");
          var insertedEdge = null;
          try {
            // Let the active Draw.io editor's default edge style apply; do not invent an arrow/routing style.
            insertedEdge = activeGraph.insertEdge(nodeParent, null, "", cell, insertedNode);
            if (!insertedEdge) throw new Error("Draw.io did not create the connecting edge");
          } catch (edgeError) {
            try { activeModel.remove(insertedNode); } catch (_) {}
            throw edgeError;
          }
          if (activeBatchCreatedCells) {
            activeBatchCreatedCells.push(insertedNode);
            activeBatchCreatedCells.push(insertedEdge);
          }
        } else if (path === "cell:delete") {
          if (cell.id === "0" || cell.id === "1") throw new Error("The Draw.io root and default layer cannot be deleted");
          if (typeof activeGraph.removeCells === "function") activeGraph.removeCells([cell], true);
          else activeModel.remove(cell);
        } else if (path.indexOf("geometry:") === 0 && cell.geometry) {
          var geometryKey = path.slice(9);
          var nextGeometry = cell.geometry.clone();
          if (geometryKey === "size") {
            var dimensions = value.split(",").map(Number);
            if (dimensions.length !== 2 || dimensions.some(function (number) { return !Number.isFinite(number) || number < 1 || number > 10000; })) throw new Error("Size must contain width and height between 1 and 10000");
            nextGeometry.width = dimensions[0];
            nextGeometry.height = dimensions[1];
          } else if (geometryKey === "translate") {
            var deltas = value.split(",").map(Number);
            if (deltas.length !== 2 || deltas.some(function (number) { return !Number.isFinite(number) || number < -10000 || number > 10000; })) throw new Error("Move delta must contain finite dx and dy between -10000 and 10000");
            nextGeometry.x = Number(nextGeometry.x || 0) + deltas[0];
            nextGeometry.y = Number(nextGeometry.y || 0) + deltas[1];
          } else if (geometryKey === "relative") {
            var boolValue = value.toLowerCase();
            if (["1", "0", "true", "false"].indexOf(boolValue) < 0) throw new Error("relative must be 1/0 or true/false");
            nextGeometry.relative = boolValue === "1" || boolValue === "true";
          } else if (["x", "y", "width", "height"].indexOf(geometryKey) >= 0) {
            var numberValue = Number(value);
            if (!Number.isFinite(numberValue)) throw new Error("Geometry must be numeric");
            nextGeometry[geometryKey] = numberValue;
          } else throw new Error("Unsupported geometry property: " + geometryKey);
          activeModel.setGeometry(cell, nextGeometry);
        } else if (path.indexOf("cell:") === 0) {
          var cellKey = path.slice(5);
          if (["visible", "collapsed", "connectable"].indexOf(cellKey) >= 0) {
            var cellBool = value.toLowerCase();
            if (["1", "0", "true", "false"].indexOf(cellBool) < 0) throw new Error(cellKey + " must be 1/0 or true/false");
            var enabled = cellBool === "1" || cellBool === "true";
            if (cellKey === "visible") activeModel.setVisible(cell, enabled);
            else if (cellKey === "collapsed") activeModel.setCollapsed(cell, enabled);
            else setCellConnectable(cell, enabled);
          } else if (cellKey === "source" || cellKey === "target") {
            var terminal = value ? activeModel.getCell(value) : null;
            if (value && !terminal) throw new Error("No cell exists with id " + value);
            if (terminal && terminal.edge) throw new Error("A connector endpoint must be a vertex, not another connector");
            if (terminal && (!terminal.geometry || !terminal.vertex)) throw new Error("A connector endpoint must be a connectable vertex");
            activeModel.setTerminal(cell, terminal, cellKey === "source");
          } else if (cellKey === "parent") {
            if (cell.id === "0" || cell.id === "1") throw new Error("The Draw.io root and default layer cannot be reparented");
            var parent = activeModel.getCell(value);
            if (!parent) throw new Error("No parent cell exists with id " + value);
            var ancestor = parent;
            while (ancestor) {
              if (ancestor === cell) throw new Error("A cell cannot be moved into itself or one of its descendants");
              ancestor = ancestor.parent;
            }
            activeModel.add(parent, cell, activeModel.getChildCount(parent));
          } else throw new Error("Unsupported cell property: " + cellKey);
        } else if (path.indexOf("valueAttr:") === 0) {
          var attrKey = path.slice(10);
          var attrValue = cell.value;
          if (!attrValue || typeof attrValue !== "object" || attrValue.nodeType !== 1) {
            throw new Error("This cell does not expose editable XML attributes");
          }
          var attrNext = attrValue.cloneNode(true);
          if (value === "") attrNext.removeAttribute(attrKey); else attrNext.setAttribute(attrKey, value);
          activeModel.setValue(cell, attrNext);
        } else throw new Error("Unsupported Draw.io property path: " + path);
      } finally {
        activeModel.endUpdate();
      }
      // Programmatic model mutations bypass Draw.io's normal UI command path; mark the
      // editor dirty while the host requests an explicit XML export for confirmation.
      if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
      if (typeof activeGraph.refresh === "function") activeGraph.refresh();
    }

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      var request;
      try { request = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
      catch (_) { return; }
      if (!request || typeof request !== "object") return;
      if (!studioParentOrigin && request.event === "studioDrawioWelcome") {
        if (!event.origin || event.origin === "null") return;
        studioParentOrigin = event.origin;
        if (bridgeHelloTimer !== null) window.clearInterval(bridgeHelloTimer);
        bridgeHelloTimer = null;
        if (pendingBridgeReadyMessage) {
          publish(pendingBridgeReadyMessage);
          pendingBridgeReadyMessage = null;
          publishSelection();
        }
        return;
      }
      if (!studioParentOrigin || event.origin !== studioParentOrigin) return;
      if (request.event === "studioDiagramStyleRequest") {
        try {
          if (typeof request.requestId !== "string" || request.requestId.length > 120) throw new Error("Invalid style request ID.");
          if (JSON.stringify(request).length > 50_000) throw new Error("The style request exceeds 50 KB.");
          applyDiagramStyleRequest(request);
        } catch (styleError) {
          publish({ event: "studioDiagramStyleResult", requestId: request.requestId, success: false,
            error: styleError && styleError.message ? String(styleError.message) : String(styleError) });
        }
        return;
      }
      if (request.event === "studioPresentationThemeRequest") {
        if (typeof request.css !== "string" || request.css.length > 50_000) return;
        var themeStyle = document.getElementById("studio-native-theme");
        if (!themeStyle) {
          themeStyle = document.createElement("style");
          themeStyle.id = "studio-native-theme";
          document.head.appendChild(themeStyle);
        }
        themeStyle.textContent = request.css;
        return;
      }
      if (request.event === "studioNativeLayoutRequest") {
        try {
          var layoutGraph = currentGraph();
          var layoutModel = typeof layoutGraph.getModel === "function" ? layoutGraph.getModel() : model;
          var layoutResult = applyNativeLayoutPlan(request.plan, layoutGraph, layoutModel);
          publish({
            event: "studioNativeLayoutResult", requestId: request.requestId, success: true,
            changedVertices: layoutResult.changedVertices, changedEdges: layoutResult.changedEdges,
            engine: layoutResult.engine, algorithm: layoutResult.algorithm
          });
        } catch (layoutError) {
          publish({
            event: "studioNativeLayoutResult", requestId: request.requestId, success: false,
            error: layoutError && layoutError.message ? String(layoutError.message) : String(layoutError),
            rollbackConfirmed: Boolean(layoutError && layoutError.rollbackConfirmed)
          });
        }
      } else if (request.event === "studioRuntimeInspectRequest") {
        try {
          var inspectGraph = currentGraph();
          var inspectModel = typeof inspectGraph.getModel === "function" ? inspectGraph.getModel() : model;
          var inspection = inspectDrawioRuntime(ui, inspectGraph, inspectModel, {
            documentRevision: typeof request.documentRevision === "string" ? request.documentRevision : "",
            drawioVersion: typeof request.drawioVersion === "string" ? request.drawioVersion : "unknown",
            maxCells: request.maxCells,
            maxRenderedEdges: request.maxRenderedEdges,
            jsShapeClassNames: request.jsShapeClassNames
          });
          publish({ event: "studioRuntimeInspectResult", requestId: request.requestId, success: true, inspection: inspection });
        } catch (inspectionError) {
          publish({ event: "studioRuntimeInspectResult", requestId: request.requestId, success: false,
            error: inspectionError && inspectionError.message ? String(inspectionError.message) : String(inspectionError) });
        }
      } else if (request.event === "studioPropertyEditRequest") {
        try {
          var editResult = editCell(request);
          publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: true, cellId: request.cellId, path: request.path,
            batchResults: editResult && editResult.batchResults || null,
            scriptResult: editResult && editResult.scriptResult || null });
        } catch (error) {
          publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: false, cellId: request.cellId, path: request.path,
            error: error && error.message ? String(error.message) : String(error),
            errorStack: error && error.stack ? String(error.stack).slice(0, 8000) : null,
            batchResults: error && error.batchResults || null,
            failedIndex: Number.isInteger(error && error.failedIndex) ? error.failedIndex : null,
            rollbackErrors: error && error.rollbackErrors || [],
            batchRolledBack: error && typeof error.batchRolledBack === "boolean" ? error.batchRolledBack : null });
        }
      } else if (request.event === "studioSetBackground") {
        var backgroundGraph = currentGraph();
        if (!hasOriginalBackground) {
          originalBackground = typeof request.restoreBackground === "string" ? request.restoreBackground : backgroundGraph.background;
          hasOriginalBackground = true;
        }
        backgroundGraph.background = request.restore
          ? (typeof request.restoreBackground === "string" ? request.restoreBackground : originalBackground)
          : request.background;
        if (backgroundGraph.view && typeof backgroundGraph.view.validateBackground === "function") backgroundGraph.view.validateBackground();
        if (typeof backgroundGraph.refresh === "function") backgroundGraph.refresh();
        publish({ event: "studioBackgroundResult", success: true });
      }
    });

    graph.getSelectionModel().addListener("change", publishSelection);
    if (typeof ui.addListener === "function") ui.addListener("pageSelected", publishSelection);
    if (typeof model.addListener === "function") model.addListener("change", publishSelection);
    var bridgeGraph = currentGraph();
    var bridgeModel = typeof bridgeGraph.getModel === "function" ? bridgeGraph.getModel() : model;
    var bridgeCapabilities = {
      graph: runtimeMethods(bridgeGraph, ["getModel", "getDefaultParent", "getChildCells", "setCellStyles", "insertVertex", "insertEdge", "removeCells", "refresh", "convertValueToString"]),
      model: runtimeMethods(bridgeModel, ["getRoot", "getChildCount", "getChildAt", "getCell", "getStyle", "setStyle", "setValue", "setGeometry", "setTerminal", "beginUpdate", "endUpdate"]),
      view: runtimeMethods(bridgeGraph && bridgeGraph.view, ["getState", "validate"])
    };
    pendingBridgeReadyMessage = {
      event: "studioBridgeReady",
      drawioVersion: "v32.0.2",
      capabilityManifest: buildCapabilityManifest(bridgeCapabilities)
    };
    requestStudioHandshake();
    });
  }
  register();
})();
