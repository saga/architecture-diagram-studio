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
        var studioParentOrigin = "";
    var activeHistoryModel = null;
    var activeHistoryListener = null;
    var activeHistoryManager = null;
    var activeHistoryManagerListeners = [];
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

    function isNativeStructuralRoot(cell, activeModel) {
      return !!cell && !!activeModel && typeof activeModel.getRoot === "function" && cell === activeModel.getRoot();
    }

    function isNativeLayerCell(cell, activeModel) {
      if (!cell || !activeModel || isNativeStructuralRoot(cell, activeModel) || cell.vertex || cell.edge || cell.geometry) return false;
      var root = typeof activeModel.getRoot === "function" ? activeModel.getRoot() : null;
      return !!root && cell.parent === root;
    }

    function isNativeStructuralRootOrLayer(cell, activeModel) {
      return isNativeStructuralRoot(cell, activeModel) || isNativeLayerCell(cell, activeModel);
    }

    // A failed native transaction must not become an Undo entry or clear an existing Redo stack
    // when its compensating writes have restored the original state. Draw.io's pinned mxGraphModel
    // accumulates these changes in currentEdit.changes until the outermost endUpdate().
    function captureNativeUndoCheckpoint(activeModel) {
      var edit = activeModel && activeModel.currentEdit;
      if (!edit || !Array.isArray(edit.changes)) return null;
      return { model: activeModel, edit: edit, changeCount: edit.changes.length };
    }

    function discardFailedNativeTransactionFromHistory(activeModel, checkpoint) {
      if (!checkpoint || checkpoint.model !== activeModel ||
          activeModel.currentEdit !== checkpoint.edit ||
          !Array.isArray(checkpoint.edit.changes) ||
          checkpoint.edit.changes.length < checkpoint.changeCount) return false;
      checkpoint.edit.changes.splice(checkpoint.changeCount);
      return checkpoint.edit.changes.length === checkpoint.changeCount;
    }

    var historyState = function () {
      var manager = ui && ui.editor && ui.editor.undoManager;
      var canUndo = false;
      var canRedo = false;
      try { canUndo = !!manager && typeof manager.canUndo === "function" && manager.canUndo(); } catch (_) {}
      try { canRedo = !!manager && typeof manager.canRedo === "function" && manager.canRedo(); } catch (_) {}
      return { canUndo: canUndo, canRedo: canRedo };
    };
    var publishHistoryState = function () {
      var state = historyState();
      publish({ event: "studioHistoryState", canUndo: state.canUndo, canRedo: state.canRedo, pageId: currentPageId() });
    };
    function bindUndoManagerListeners() {
      var manager = ui && ui.editor && ui.editor.undoManager;
      if (!manager || manager === activeHistoryManager) return;
      if (activeHistoryManager && typeof activeHistoryManager.removeListener === "function") {
        activeHistoryManagerListeners.forEach(function (listener) {
          try { activeHistoryManager.removeListener(listener); } catch (_) {}
        });
      }
      activeHistoryManager = manager;
      activeHistoryManagerListeners = [];
      if (typeof manager.addListener !== "function") return;
      ["add", "undo", "redo", "clear"].forEach(function (eventName) {
        var listener = function () { publishHistoryState(); };
        manager.addListener(eventName, listener);
        activeHistoryManagerListeners.push(listener);
      });
    }
    var publishSelection = function () {
      bindUndoManagerListeners();
      var selectedGraph = currentGraph();
      var cells = typeof selectedGraph.getSelectionCells === "function" ? selectedGraph.getSelectionCells() : [];
      var cell = cells && cells.length ? cells[0] : null;
      var id = cell && (typeof cell.getId === "function" ? cell.getId() : cell.id);
      var nativeCellIds = (cells || []).map(runtimeCellId).filter(Boolean);
      var vertexCellIds = (cells || []).filter(function (selected) {
        return !!selected && selected.vertex === true;
      }).map(runtimeCellId).filter(Boolean);
      publish({
        event: "studioSelectionChanged",
        cellId: typeof id === "string" && id ? id : null,
        cellIds: nativeCellIds,
        vertexCellIds: vertexCellIds,
        pageId: currentPageId()
      });
      publishHistoryState();
    };
    function bindHistoryModelListener() {
      var selectedGraph = currentGraph();
      var selectedModel = selectedGraph && typeof selectedGraph.getModel === "function" ? selectedGraph.getModel() : model;
      if (!selectedModel || selectedModel === activeHistoryModel) return;
      if (activeHistoryModel && activeHistoryListener && typeof activeHistoryModel.removeListener === "function") {
        try { activeHistoryModel.removeListener(activeHistoryListener); } catch (_) {}
      }
      activeHistoryModel = selectedModel;
      activeHistoryListener = typeof activeHistoryModel.addListener === "function" ? publishHistoryState : null;
      if (activeHistoryListener) activeHistoryModel.addListener("change", activeHistoryListener);
    }

    function inspectDrawioRuntime(options) {
      options = options && typeof options === "object" ? options : {};
      // Only identity and the live shape registry are consumed. Native cells come from the XML
      // document, so walking the whole graph on every request produced data nobody read.
      var shapeRegistry = window.mxCellRenderer && window.mxCellRenderer.defaultShapes;
      var allLiveShapeClasses = shapeRegistry && typeof shapeRegistry === "object"
        ? Object.keys(shapeRegistry).filter(function (name) {
            return /^[A-Za-z0-9_$:.-]{1,160}$/.test(name) && typeof shapeRegistry[name] === "function" &&
              name !== "__proto__" && name !== "constructor" && name !== "prototype";
          }).sort()
        : [];
      var liveShapeClassesTruncated = allLiveShapeClasses.length > 2000;
      return {
        schemaVersion: 1, bridgeVersion: "studio-native-runtime/5",
        drawioVersion: typeof options.drawioVersion === "string" ? options.drawioVersion : "unknown",
        documentRevision: typeof options.documentRevision === "string" ? options.documentRevision : "",
        pageId: currentPageId(),
        // Live shape registration does not guarantee a usable stencil or visible sidebar entry.
        liveShapeClasses: allLiveShapeClasses.slice(0, 2000),
        liveShapeClassesTruncated: liveShapeClassesTruncated
      };
    }

    function hasNestedLabelMarkup(source) {
      var outer = /^\s*<([a-z][\w:-]*)\b[^>]*>([\s\S]*)<\/\1>\s*$/i.exec(source);
      if (!outer) return /<[a-z][^>]*>/i.test(source);
      return /<[a-z][^>]*>/i.test(outer[2]);
    }

    function updateLabelMarkup(source, value) {
      if (typeof source !== "string" || !/<[a-z][^>]*>/i.test(source)) return value;
      // Setting a whole plain-text label by replacing rich HTML would silently erase nested
      // formatting, line breaks and placeholder spans; that needs an explicit XML patch instead.
      if (!/<[a-z][^>]*>/i.test(value) && hasNestedLabelMarkup(source)) {
        throw new Error("This cell has a rich HTML label; a plain set_label would discard nested formatting or placeholders. Use the server-side XML patch capability to preserve the existing markup.");
      }
      if (/<[a-z][^>]*>/i.test(value)) return value;
      var parsed = new DOMParser().parseFromString(source, "text/html");
      var container = parsed.body.firstElementChild;
      if (!container) return value;
      container.textContent = value;
      return container.outerHTML;
    }

    /* The layout/palette transaction implementations remain native and revision-bound. */
    function applyNativeLayoutPlan(plan, activeGraph, activeModel) {
      function fail(message, rollbackConfirmed) { var error = new Error(message); error.rollbackConfirmed = rollbackConfirmed === true; throw error; }
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.expectedPageCellIds) || !Array.isArray(plan.expectedCells) || !Array.isArray(plan.positions) || !Array.isArray(plan.edgeRoutes)) fail("The Studio layout plan is malformed; nothing was changed.", true);
      var supportedAlgorithms = { elk: ["layered", "mrtree", "radial", "stress", "force", "box", "rectpacking", "random"], dagre: ["layered"], graphviz: ["dot", "neato", "fdp", "sfdp", "circo", "twopi"], msagl: ["layered", "mds", "ipsepcola"], cytoscape: ["breadthfirst", "circle", "concentric", "grid", "random", "cose"], d3: ["tree", "cluster", "force"] };
      if (!Object.prototype.hasOwnProperty.call(supportedAlgorithms, plan.engine)) fail("Unsupported Studio layout engine.", true);
      if (!supportedAlgorithms[plan.engine].includes(plan.algorithm) || !["RIGHT", "LEFT", "DOWN", "UP"].includes(plan.direction) || ((plan.algorithm === "box" || plan.algorithm === "rectpacking") && plan.edgeRoutes.length > 0)) fail("Unsupported Studio layout algorithm or direction.", true);
      function boundedPlanNumber(value, min, max) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
      if (typeof plan.preserveLocalGrouping !== "boolean" || typeof plan.preserveCanvasOrigin !== "boolean" ||
          typeof plan.preserveRelativeAnchors !== "boolean" || !Array.isArray(plan.anchorCellIds) ||
          plan.anchorCellIds.length > 32 || !boundedPlanNumber(plan.nodeSpacing, 5, 500) ||
          !boundedPlanNumber(plan.layerSpacing, 10, 800) || !boundedPlanNumber(plan.iterations, 20, 3000) ||
          !boundedPlanNumber(plan.randomSeed, 0, 100000) || !Number.isInteger(plan.iterations) ||
          !Number.isInteger(plan.randomSeed) || !boundedPlanNumber(plan.margin, 0, 300) ||
          ["ORTHOGONAL", "POLYLINE", "SPLINES"].indexOf(plan.edgeRouting) < 0) fail("The Studio layout plan contains invalid or out-of-range configuration values.", true);
      if ((!plan.preserveRelativeAnchors && plan.anchorCellIds.length !== 0) ||
          (plan.preserveRelativeAnchors && plan.anchorCellIds.length === 1)) fail("The Studio layout plan's relative-anchor selection does not match its settings.", true);
      var hasRelativeAnchorConstraints = plan.preserveRelativeAnchors && plan.anchorCellIds.length >= 2;
      var anchorDiagnostics = plan.anchorDiagnostics;
      if (!anchorDiagnostics || typeof anchorDiagnostics !== "object" ||
          ["not-requested", "applied", "degraded"].indexOf(anchorDiagnostics.outcome) < 0 ||
          !Number.isInteger(anchorDiagnostics.requestedAnchorCount) ||
          !Number.isInteger(anchorDiagnostics.resolvedAnchorCount) ||
          !Number.isInteger(anchorDiagnostics.effectiveAnchorUnitCount) ||
          !Number.isInteger(anchorDiagnostics.evaluatedPairCount) ||
          !boundedPlanNumber(anchorDiagnostics.maximumVectorDrift, 0, 10000000) ||
          !boundedPlanNumber(anchorDiagnostics.meanVectorDrift, 0, 10000000) ||
          !boundedPlanNumber(anchorDiagnostics.toleranceBandPx, 0, 100000) ||
          !Number.isInteger(anchorDiagnostics.toleranceViolationCount) || anchorDiagnostics.toleranceViolationCount < 0 ||
          !Number.isInteger(anchorDiagnostics.directionalOrderViolations) ||
          !Number.isInteger(anchorDiagnostics.refinementIterations) ||
          !Number.isInteger(anchorDiagnostics.collisionAdjustments) ||
          anchorDiagnostics.refinementIterations < 0 || anchorDiagnostics.refinementIterations > 200 ||
          anchorDiagnostics.directionalOrderViolations < 0 || anchorDiagnostics.collisionAdjustments < 0) {
        fail("The Studio layout plan's relative-anchor diagnostics are invalid.", true);
      }
      if (hasRelativeAnchorConstraints &&
          (anchorDiagnostics.outcome === "not-requested" ||
           anchorDiagnostics.requestedAnchorCount !== plan.anchorCellIds.length ||
           anchorDiagnostics.resolvedAnchorCount !== plan.anchorCellIds.length ||
           anchorDiagnostics.effectiveAnchorUnitCount < 2 ||
           anchorDiagnostics.evaluatedPairCount !== anchorDiagnostics.effectiveAnchorUnitCount * (anchorDiagnostics.effectiveAnchorUnitCount - 1) / 2)) {
        fail("The Studio layout plan's relative-anchor result is incomplete or inconsistent.", true);
      }
      if (!hasRelativeAnchorConstraints &&
          (anchorDiagnostics.outcome !== "not-requested" ||
           anchorDiagnostics.requestedAnchorCount !== 0 ||
           anchorDiagnostics.resolvedAnchorCount !== 0 ||
           anchorDiagnostics.effectiveAnchorUnitCount !== 0 ||
           anchorDiagnostics.evaluatedPairCount !== 0)) {
        fail("The Studio layout plan reports anchor optimization without an effective anchor selection.", true);
      }
      if (typeof plan.documentRevision !== "string" || !/^[a-f0-9]{64}$/i.test(plan.documentRevision)) fail("The Studio layout plan is not bound to a valid native XML revision.", true);
      if (plan.positions.length < 1 || plan.positions.length > 5000 || plan.expectedPageCellIds.length > 20000 || plan.expectedCells.length > 10000 || plan.edgeRoutes.length > 10000) fail("The Studio layout plan exceeds native editor limits.", true);
      var livePageId = currentPageId();
      if ((plan.pageId || null) !== (livePageId || null)) fail("The active Draw.io page changed after layout calculation. Recalculate layout before applying it.", true);
      var root = activeModel.getRoot();
      var liveCells = [];
      var seenObjects = new Set();
      var stack = [root];
      while (stack.length) {
        var parent = stack.pop();
        if (!parent || seenObjects.has(parent)) continue;
        seenObjects.add(parent); liveCells.push(parent);
        var childCount = activeModel.getChildCount(parent);
        for (var index = childCount - 1; index >= 0; index--) { var child = activeModel.getChildAt(parent, index); if (child) stack.push(child); }
        if (liveCells.length > 20000) fail("The active page is too large for safe automatic layout.", true);
      }
      var liveById = Object.create(null);
      liveCells.forEach(function (cell) { var id = runtimeCellId(cell); if (id) liveById[id] = cell; });
      var expectedIds = plan.expectedPageCellIds.slice().map(String).sort();
      var liveIds = liveCells.map(runtimeCellId).filter(Boolean).sort();
      if (expectedIds.length !== liveIds.length || expectedIds.some(function (id, index) { return id !== liveIds[index]; })) fail("The native page's cell set changed while the layout was being calculated. No layout was applied.", true);
      var seenAnchorCellIds = Object.create(null);
      plan.anchorCellIds.forEach(function (anchorCellId) {
        if (typeof anchorCellId !== "string" || !anchorCellId || seenAnchorCellIds[anchorCellId]) {
          fail("The relative-anchor list contains an empty or duplicate native cell ID.", true);
        }
        seenAnchorCellIds[anchorCellId] = true;
        var anchorCell = liveById[anchorCellId];
        if (!anchorCell || !anchorCell.vertex || !anchorCell.geometry) {
          fail("A relative anchor is missing or is not a native vertex with geometry: " + anchorCellId, true);
        }
      });
      function near(actual, expected) { return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - Number(expected)) < 0.02; }
      plan.expectedCells.forEach(function (expected) {
        var cell = liveById[expected.cellId];
        if (!cell || !cell.geometry || runtimeCellId(cell.parent) !== expected.parentId) fail("A layout target was deleted, moved to another parent, or lost its geometry: " + expected.cellId, true);
        if (!near(cell.geometry.x, expected.x) || !near(cell.geometry.y, expected.y) || !near(cell.geometry.width, expected.width) || !near(cell.geometry.height, expected.height)) fail("Native geometry changed after layout calculation; no nodes were moved. Recalculate layout and retry.", true);
        if (expected.kind === "edge" && (runtimeCellId(cell.source) !== expected.sourceId || runtimeCellId(cell.target) !== expected.targetId)) fail("A connector endpoint changed after layout calculation; no layout was applied.", true);
        if (expected.kind === "vertex" && !cell.vertex) fail("A layout target is no longer a vertex: " + expected.cellId, true);
        if (expected.kind === "edge" && !cell.edge) fail("A layout target is no longer a connector: " + expected.cellId, true);
      });
      var positionsById = Object.create(null);
      plan.positions.forEach(function (item) {
        if (!item || typeof item.cellId !== "string" || !Number.isFinite(item.x) || !Number.isFinite(item.y) || Math.abs(item.x) > 1000000 || Math.abs(item.y) > 1000000 || positionsById[item.cellId]) fail("The layout plan contains duplicate or invalid node coordinates.", true);
        var target = liveById[item.cellId];
        if (!target || !target.vertex || !target.geometry) fail("A layout plan references a missing vertex: " + item.cellId, true);
        positionsById[item.cellId] = { x: item.x, y: item.y };
      });
      if (Object.keys(positionsById).length !== plan.expectedCells.filter(function (item) { return item.kind === "vertex"; }).length) fail("The layout plan does not contain every expected vertex exactly once.", true);
      var routesById = Object.create(null);
      plan.edgeRoutes.forEach(function (route) {
        if (!route || typeof route.cellId !== "string" || !Array.isArray(route.points) || routesById[route.cellId]) fail("The layout plan contains a duplicate or invalid connector route.", true);
        if (!liveById[route.cellId] || !liveById[route.cellId].edge || !liveById[route.cellId].geometry) fail("A layout plan references a missing connector: " + route.cellId, true);
        if (route.points.length > 100 || route.points.some(function (point) { return !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1000000 || Math.abs(point.y) > 1000000; })) fail("The layout plan contains invalid connector waypoints.", true);
        if (plan.edgeRouting === "ORTHOGONAL" && route.points.some(function (point, index) {
          if (index === 0) return false;
          var previous = route.points[index - 1];
          return Math.abs(point.x - previous.x) > 0.5 && Math.abs(point.y - previous.y) > 0.5;
        })) fail("The layout plan contains a non-orthogonal connector segment: " + route.cellId, true);
        routesById[route.cellId] = route.points;
      });
      var expectedEdgeIds = plan.expectedCells.filter(function (item) { return item.kind === "edge"; }).map(function (item) { return item.cellId; }).sort();
      var plannedEdgeIds = Object.keys(routesById).sort();
      if (expectedEdgeIds.length !== plannedEdgeIds.length || expectedEdgeIds.some(function (id, index) { return id !== plannedEdgeIds[index]; })) fail("The layout plan does not contain a route result for every targeted connector.", true);
      var snapshots = plan.expectedCells.map(function (expected) {
        var cell = liveById[expected.cellId];
        return { cell: cell, geometry: cell.geometry.clone(), style: cell.style };
      });
      var undoCheckpoint = captureNativeUndoCheckpoint(activeModel);
      var changedVertices = 0; var changedEdges = 0;
      activeModel.beginUpdate();
      try {
        plan.positions.forEach(function (item) { var cell = liveById[item.cellId]; var geometry = cell.geometry.clone(); if (geometry.x === item.x && geometry.y === item.y) return; geometry.x = item.x; geometry.y = item.y; activeModel.setGeometry(cell, geometry); changedVertices++; });
        plan.edgeRoutes.forEach(function (route) {
          var cell = liveById[route.cellId];
          var geometry = cell.geometry.clone();
          geometry.points = route.points.length ? route.points.map(function (point) {
            return typeof window.mxPoint === "function" ? new window.mxPoint(point.x, point.y) : { x: point.x, y: point.y };
          }) : null;
          activeModel.setGeometry(cell, geometry);
          var routeStyle = setStyleValue(cell.style, "orthogonal", plan.edgeRouting === "ORTHOGONAL" ? "1" : "0");
          routeStyle = setStyleValue(routeStyle, "curved", plan.edgeRouting === "SPLINES" ? "1" : "0");
          if (routeStyle !== cell.style) activeModel.setStyle(cell, routeStyle);
          changedEdges++;
        });
      } catch (mutationError) {
        var rollbackErrors = [];
        snapshots.forEach(function (snapshot) {
          try {
            activeModel.setGeometry(snapshot.cell, snapshot.geometry);
            if (snapshot.cell.style !== snapshot.style) activeModel.setStyle(snapshot.cell, snapshot.style);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError && rollbackError.message ? String(rollbackError.message) : String(rollbackError));
          }
        });
        if (rollbackErrors.length === 0 && !discardFailedNativeTransactionFromHistory(activeModel, undoCheckpoint)) rollbackErrors.push("Native Undo/Redo history could not be restored to its pre-layout checkpoint.");
        fail("Studio auto layout failed while applying geometry: " + (mutationError && mutationError.message ? String(mutationError.message) : String(mutationError)) + (rollbackErrors.length ? "; geometry/history rollback was incomplete: " + rollbackErrors.join("; ") : "; prior geometry and native history were restored."), rollbackErrors.length === 0);
      } finally { activeModel.endUpdate(); }
      if ((changedVertices > 0 || changedEdges > 0) && ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
      if (typeof activeGraph.refresh === "function") activeGraph.refresh();
      return { changedVertices: changedVertices, changedEdges: changedEdges, engine: plan.engine, algorithm: plan.algorithm };
    }

    function paletteStyleValue(style, key) {
      var found = null;
      String(style || "").split(";").forEach(function (part) {
        var equalsAt = part.indexOf("=");
        if (equalsAt > 0 && part.slice(0, equalsAt).trim() === key) found = part.slice(equalsAt + 1).trim();
      });
      return found;
    }
    function setStyleValue(style, key, value) {
      var parts = String(style || "").split(";").filter(function (part) { return part.trim().length > 0; });
      var found = false;
      parts = parts.map(function (part) {
        var equalsAt = part.indexOf("=");
        if (equalsAt > 0 && part.slice(0, equalsAt).trim() === key) {
          found = true;
          return key + "=" + value;
        }
        return part;
      });
      if (!found) parts.push(key + "=" + value);
      return parts.join(";") + ";";
    }
    function stencilPayloadFromStyle(style) {
      var shape = paletteStyleValue(style, "shape");
      var match = typeof shape === "string" ? shape.match(/^stencil\(([^)]+)\)$/i) : null;
      return match ? match[1] : null;
    }
    function decodePaletteStencil(payload) {
      if (!payload || !window.mxUtils || typeof window.mxUtils.decompress !== "function") return null;
      try {
        var xml = window.mxUtils.decompress(payload);
        if (typeof xml !== "string") return null;
        if (/^%3cshape/i.test(xml.trim())) xml = decodeURIComponent(xml);
        return xml;
      } catch (_) { return null; }
    }
    function isTransparentPaletteStencilColor(value) {
      return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/i.test(String(value || "").trim());
    }
    function neutralPaletteStencilColor(value) {
      var color = String(value || "").trim();
      if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return false;
      var hex = color.slice(1);
      if (hex.length === 3) hex = hex.split("").map(function (part) { return part + part; }).join("");
      var rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
      return Math.max.apply(Math, rgb) - Math.min.apply(Math, rgb) <= 8;
    }
    function neutralPaletteStencilMidtone(value) {
      var color = String(value || "").trim();
      if (!neutralPaletteStencilColor(color)) return false;
      var hex = color.slice(1);
      if (hex.length === 3) hex = hex.split("").map(function (part) { return part + part; }).join("");
      var rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
      var brightness = (rgb[0] + rgb[1] + rgb[2]) / 3;
      return brightness >= 120 && brightness <= 245;
    }
    function paletteStencilColorsSafe(xml, currentFill, hasRole) {
      var colors = Array.from(String(xml || "").matchAll(/\bcolor="([^"]+)"/gi), function (match) { return match[1]; });
      return colors.length > 0 && colors.every(function (color) {
        return isTransparentPaletteStencilColor(color) || neutralPaletteStencilColor(color) ||
          (hasRole && currentFill && color.toLowerCase() === currentFill.toLowerCase());
      });
    }
    function stencilFillFingerprint(xml) {
      return String(xml || "").replace(/(<fillcolor\b[^>]*?\bcolor=")[^"]*(")/gi, "$1__STUDIO_FILL__$2");
    }
    function paletteStencilMutationIsSafe(beforeStyle, afterStyle, cell) {
      if (!cell || !cell.vertex || !cell.geometry) return false;
      var width = Number(cell.geometry.width); var height = Number(cell.geometry.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width * height < 20000) return false;
      var beforePayload = stencilPayloadFromStyle(beforeStyle);
      var afterPayload = stencilPayloadFromStyle(afterStyle);
      if (!beforePayload || !afterPayload) return false;
      var beforeXml = decodePaletteStencil(beforePayload);
      var afterXml = decodePaletteStencil(afterPayload);
      if (!beforeXml || !afterXml) return false;
      var beforeFill = paletteStyleValue(beforeStyle, "fillColor");
      var afterFill = paletteStyleValue(afterStyle, "fillColor");
      var beforeRole = paletteStyleValue(beforeStyle, "studioColorRole");
      var afterRole = paletteStyleValue(afterStyle, "studioColorRole");
      if (!paletteStencilColorsSafe(beforeXml, beforeFill, Boolean(beforeRole)) ||
          !paletteStencilColorsSafe(afterXml, afterFill, Boolean(afterRole))) return false;
      if (stencilFillFingerprint(beforeXml) !== stencilFillFingerprint(afterXml)) return false;
      var beforeFills = Array.from(beforeXml.matchAll(/<fillcolor\b[^>]*?\bcolor="([^"]+)"/gi), function (match) { return match[1]; });
      var afterFills = Array.from(afterXml.matchAll(/<fillcolor\b[^>]*?\bcolor="([^"]+)"/gi), function (match) { return match[1]; });
      if (!beforeFills.length || beforeFills.length !== afterFills.length) return false;
      var changed = false;
      for (var index = 0; index < beforeFills.length; index++) {
        var oldColor = beforeFills[index];
        var nextColor = afterFills[index];
        if (oldColor === nextColor) continue;
        var oldWasThemedFill = Boolean(beforeRole && beforeFill && oldColor.toLowerCase() === beforeFill.toLowerCase());
        var oldIsEligible = neutralPaletteStencilMidtone(oldColor) || oldWasThemedFill;
        if (!oldIsEligible || !afterFill || nextColor.toLowerCase() !== afterFill.toLowerCase()) return false;
        changed = true;
      }
      return changed;
    }
    function applyNativePalettePlan(plan, activeGraph, activeModel) {
      function fail(message, rollbackConfirmed) { var error = new Error(message); error.rollbackConfirmed = rollbackConfirmed === true; throw error; }
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.expectedPageCellIds) || !Array.isArray(plan.changes) || ["ocean-depths", "sunset-boulevard", "forest-canopy", "modern-minimalist", "golden-hour", "arctic-frost", "desert-rose", "tech-innovation", "botanical-garden", "midnight-galaxy"].indexOf(plan.theme) < 0) fail("The Studio color plan is malformed; nothing was changed.", true);
      if (typeof plan.documentRevision !== "string" || !/^[a-f0-9]{64}$/i.test(plan.documentRevision)) fail("The Studio color plan is not bound to a valid native XML revision.", true);
      if (plan.expectedBackground !== null && (typeof plan.expectedBackground !== "string" || plan.expectedBackground.length > 500)) fail("The Studio color plan contains an invalid expected page background.", true);
      if (plan.background !== null && (typeof plan.background !== "string" || !/^#[0-9a-f]{6}$/i.test(plan.background))) fail("The Studio color plan contains an invalid target page background.", true);
      if (plan.expectedPageCellIds.length < 1 || plan.expectedPageCellIds.length > 20000 || plan.changes.length > 10000) fail("The Studio color plan is empty or exceeds native editor limits.", true);
      if (plan.changes.length === 0 && plan.expectedBackground === plan.background) fail("The Studio color plan does not contain any changes.", true);
      if (!activeModel || typeof activeModel.getRoot !== "function" || typeof activeModel.getChildCount !== "function" || typeof activeModel.getChildAt !== "function" || typeof activeModel.getStyle !== "function" || typeof activeModel.setStyle !== "function" || typeof activeModel.beginUpdate !== "function" || typeof activeModel.endUpdate !== "function") fail("The active Draw.io model does not expose the required native style transaction API.", true);
      if ((plan.pageId || null) !== (currentPageId() || null)) fail("The active Draw.io page changed after color calculation. Select the preset again.", true);
      var originalGraphBackground = activeGraph.background == null ? null : String(activeGraph.background);
      if (originalGraphBackground !== plan.expectedBackground) fail("The active Draw.io page background changed after color calculation. Select the preset again.", true);
      var backgroundChanged = plan.background !== originalGraphBackground;
      if (backgroundChanged && typeof activeModel.execute !== "function") fail("The native Draw.io model does not support an undoable background transaction.", true);
      var uniqueExpectedIds = new Set();
      for (var e = 0; e < plan.expectedPageCellIds.length; e++) { var expectedId = plan.expectedPageCellIds[e]; if (typeof expectedId !== "string" || !expectedId || expectedId.length > 500 || uniqueExpectedIds.has(expectedId)) fail("The Studio color plan contains invalid or duplicate native cell IDs.", true); uniqueExpectedIds.add(expectedId); }
      var root = activeModel && typeof activeModel.getRoot === "function" ? activeModel.getRoot() : null;
      if (!root) fail("The active Draw.io model is unavailable.", true);
      var allCells = []; var liveById = Object.create(null); var seenObjects = new Set(); var stack = [root];
      while (stack.length) {
        var cell = stack.pop();
        if (!cell || seenObjects.has(cell)) continue;
        seenObjects.add(cell);
        var cellId = runtimeCellId(cell);
        if (!cellId || Object.prototype.hasOwnProperty.call(liveById, cellId)) fail("The active Draw.io model has missing or duplicate cell IDs.", true);
        liveById[cellId] = cell; allCells.push(cell);
        if (allCells.length > 20000) fail("The active Draw.io page exceeds the color-plan cell limit.", true);
        var childCount = typeof activeModel.getChildCount === "function" ? activeModel.getChildCount(cell) : 0;
        for (var childIndex = childCount - 1; childIndex >= 0; childIndex--) { var child = activeModel.getChildAt(cell, childIndex); if (child && !seenObjects.has(child)) stack.push(child); }
      }
      var liveIds = allCells.map(runtimeCellId).sort(); var expectedIds = plan.expectedPageCellIds.slice().sort();
      if (liveIds.length !== expectedIds.length || liveIds.some(function (id, index) { return id !== expectedIds[index]; })) fail("The active Draw.io page changed after color calculation. No colors were applied; select the preset again.", true);
      var allowedCellStyles = { fillColor: true, strokeColor: true, fontColor: true, gradientColor: true, labelBackgroundColor: true, labelBorderColor: true, swimlaneFillColor: true, indicatorColor: true, indicatorGradientColor: true, separatorColor: true, fontColor2: true, studioColorRole: true, shape: true };
      function normalizedStyle(cell) { var style = typeof activeModel.getStyle === "function" ? activeModel.getStyle(cell) : cell.style; return typeof style === "string" ? style : ""; }
      function nonColorStyleSegments(style) { return String(style || "").split(";").filter(function (part) { var trimmed = part.trim(); if (!trimmed) return false; var equalsAt = trimmed.indexOf("="); var key = equalsAt > 0 ? trimmed.slice(0, equalsAt).trim() : ""; return !Object.prototype.hasOwnProperty.call(allowedCellStyles, key); }); }
      var changeIds = new Set(); var snapshots = [];
      for (var c = 0; c < plan.changes.length; c++) {
        var change = plan.changes[c];
        if (!change || typeof change.cellId !== "string" || !uniqueExpectedIds.has(change.cellId) || changeIds.has(change.cellId) || (change.kind !== "vertex" && change.kind !== "edge") || typeof change.expectedStyle !== "string" || change.expectedStyle.length > 20000 || typeof change.style !== "string" || change.style.length > 20000) fail("The Studio color plan contains an invalid style change.", true);
        changeIds.add(change.cellId); var liveCell = liveById[change.cellId];
        if (!liveCell || (change.kind === "vertex" ? !liveCell.vertex : !liveCell.edge)) fail("A target cell is no longer the expected vertex or connector: " + change.cellId, true);
        if (normalizedStyle(liveCell) !== change.expectedStyle) fail("A target cell's style changed after color calculation: " + change.cellId + ". No colors were applied.", true);
        var beforeShape = paletteStyleValue(change.expectedStyle, "shape"); var afterShape = paletteStyleValue(change.style, "shape");
        if (beforeShape !== afterShape && !paletteStencilMutationIsSafe(change.expectedStyle, change.style, liveCell)) fail("The color plan attempts to alter stencil geometry or recolor a non-neutral stencil asset.", true);
        var beforeNonColors = nonColorStyleSegments(change.expectedStyle); var afterNonColors = nonColorStyleSegments(change.style);
        if (beforeNonColors.length !== afterNonColors.length || beforeNonColors.some(function (part, index) { return part !== afterNonColors[index]; })) fail("The color plan attempts to change a non-color style property.", true);
        function stylePropertyValue(style, key) { var found = null; String(style || "").split(";").forEach(function (part) { var equalsAt = part.indexOf("="); if (equalsAt > 0 && part.slice(0, equalsAt).trim() === key) found = part.slice(equalsAt + 1).trim(); }); return found; }
        function validColorRole(value) { return value === "base" || value === "text" || /^category-[1-8]$/.test(String(value || "")); }
        function isTextStyle(style) { return String(style || "").split(";").some(function (part) { var trimmed = part.trim(); if (trimmed === "text") return true; var equalsAt = trimmed.indexOf("="); return equalsAt > 0 && trimmed.slice(0, equalsAt).trim() === "shape" && trimmed.slice(equalsAt + 1).trim() === "text"; }); }
        var beforeRole = stylePropertyValue(change.expectedStyle, "studioColorRole"); var afterRole = stylePropertyValue(change.style, "studioColorRole");
        if (!validColorRole(afterRole) || (beforeRole !== null && beforeRole !== afterRole)) fail("The color plan contains an invalid or unstable category-role marker.", true);
        var textOnlyVertex = change.kind === "vertex" && isTextStyle(normalizedStyle(liveCell));
        if ((textOnlyVertex && afterRole !== "text") || (!textOnlyVertex && afterRole === "text")) fail("The Studio color plan contains a text role that conflicts with the native cell type.", true);
        snapshots.push({ cell: liveCell, cellId: change.cellId, style: liveCell.style, nextStyle: change.style });
      }
      var undoCheckpoint = captureNativeUndoCheckpoint(activeModel);
      var pendingBackgroundValue = plan.background;
      activeModel.beginUpdate();
      try {
        snapshots.forEach(function (snapshot) { activeModel.setStyle(snapshot.cell, snapshot.nextStyle); });
        if (backgroundChanged) {
          // Record the graph-background toggle as a native model change, making it share one undo entry with cell styles.
          activeModel.execute({
            execute: function () {
              var previousBackground = activeGraph.background == null ? null : String(activeGraph.background);
              activeGraph.background = pendingBackgroundValue;
              pendingBackgroundValue = previousBackground;
              if (activeGraph.view && typeof activeGraph.view.validateBackground === "function") activeGraph.view.validateBackground();
              if (typeof activeGraph.refresh === "function") activeGraph.refresh();
            }
          });
        }
      }
      catch (mutationError) {
        var rollbackErrors = [];
        if ((activeGraph.background == null ? null : String(activeGraph.background)) !== originalGraphBackground) {
          try {
            activeGraph.background = originalGraphBackground;
            if (activeGraph.view && typeof activeGraph.view.validateBackground === "function") activeGraph.view.validateBackground();
            if (typeof activeGraph.refresh === "function") activeGraph.refresh();
          } catch (backgroundRollbackError) {
            rollbackErrors.push("page background: " + (backgroundRollbackError && backgroundRollbackError.message ? String(backgroundRollbackError.message) : String(backgroundRollbackError)));
          }
        }
        snapshots.slice().reverse().forEach(function (snapshot) {
          try { activeModel.setStyle(snapshot.cell, snapshot.style); }
          catch (rollbackError) { rollbackErrors.push(snapshot.cellId + ": " + (rollbackError && rollbackError.message ? String(rollbackError.message) : String(rollbackError))); }
        });
        if (rollbackErrors.length === 0 && !discardFailedNativeTransactionFromHistory(activeModel, undoCheckpoint)) rollbackErrors.push("Native Undo/Redo history could not be restored to its pre-color checkpoint.");
        fail("Studio color application failed: " + (mutationError && mutationError.message ? String(mutationError.message) : String(mutationError)) + (rollbackErrors.length ? "; style/background/history rollback was incomplete: " + rollbackErrors.join("; ") : "; previous styles, background and native history were restored."), rollbackErrors.length === 0);
      } finally { activeModel.endUpdate(); }
      if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
      if (activeGraph.view && typeof activeGraph.view.validateBackground === "function") activeGraph.view.validateBackground();
      if (typeof activeGraph.refresh === "function") activeGraph.refresh();
      return { changedCells: snapshots.length, changedBackground: backgroundChanged };
    }

    function editCell(request) {
      var activeGraph = currentGraph();
      var activeModel = typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model;
      function setCellConnectable(cell, value) {
        if (!cell) throw new Error("Cannot change connectability on a missing cell");
        if (typeof activeModel.setConnectable === "function") activeModel.setConnectable(cell, value);
        else if (typeof cell.setConnectable === "function") cell.setConnectable(value);
        else cell.connectable = value;
      }
      var selectionOperation = String(request.path || "");
      var requestedPage = request.pageId;
      var activePage = currentPageId();
      if (requestedPage && activePage && requestedPage !== activePage) throw new Error("The active Draw.io page changed before the edit");
      if (request.cellId === "__selection__" && /^(cell:align:|cell:distribute:|cell:group$|cell:ungroup$)/.test(selectionOperation)) {
        var selected = typeof activeGraph.getSelectionCells === "function" ? activeGraph.getSelectionCells().slice() : [];
        var vertices = selected.filter(function (item) { return item && item.vertex && item.geometry; });
        if (selectionOperation === "cell:group" || selectionOperation === "cell:ungroup") {
          if (selected.length < (selectionOperation === "cell:group" ? 2 : 1)) throw new Error("Select at least two cells to group, or a group to ungroup");
          activeModel.beginUpdate();
          try {
            if (selectionOperation === "cell:group") { if (typeof activeGraph.groupCells !== "function") throw new Error("This Draw.io build does not expose groupCells"); activeGraph.groupCells(null, 0, selected); }
            else { var groups = selected.filter(function (item) { return item && item.vertex && activeModel.getChildCount(item) > 0; }); if (!groups.length) throw new Error("Select a group cell to ungroup"); if (typeof activeGraph.ungroupCells !== "function") throw new Error("This Draw.io build does not expose ungroupCells"); activeGraph.ungroupCells(groups); }
          } finally { activeModel.endUpdate(); }
          if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
          if (typeof activeGraph.refresh === "function") activeGraph.refresh();
          return;
        }
        if (vertices.length < 2) throw new Error("Select at least two vertex cells to align or distribute");
        var alignMode = selectionOperation.slice("cell:align:".length); var distributeMode = selectionOperation.slice("cell:distribute:".length); var isAlign = selectionOperation.indexOf("cell:align:") === 0;
        if ((isAlign && ["left", "right", "top", "bottom", "center", "middle"].indexOf(alignMode) < 0) || (!isAlign && ["horizontal", "vertical"].indexOf(distributeMode) < 0)) throw new Error("Unsupported selection layout operation");
        var parent = vertices[0].parent;
        if (vertices.some(function (item) { return item.parent !== parent; })) throw new Error("Align and distribute only support cells in the same layer or group");
        var snapshots = vertices.map(function (item) { return { cell: item, geometry: item.geometry.clone() }; }); var undoCheckpoint = captureNativeUndoCheckpoint(activeModel);
        activeModel.beginUpdate();
        try {
          if (isAlign) {
            var bounds = vertices.map(function (item) { return item.geometry; }); var left = Math.min.apply(Math, bounds.map(function (g) { return g.x; })); var top = Math.min.apply(Math, bounds.map(function (g) { return g.y; })); var right = Math.max.apply(Math, bounds.map(function (g) { return g.x + g.width; })); var bottom = Math.max.apply(Math, bounds.map(function (g) { return g.y + g.height; }));
            vertices.forEach(function (item) { var g = item.geometry.clone(); if (alignMode === "left") g.x = left; else if (alignMode === "right") g.x = right - g.width; else if (alignMode === "top") g.y = top; else if (alignMode === "bottom") g.y = bottom - g.height; else if (alignMode === "center") g.x = left + (right - left - g.width) / 2; else g.y = top + (bottom - top - g.height) / 2; activeModel.setGeometry(item, g); });
          } else {
            var axis = distributeMode === "horizontal" ? "x" : "y"; var extent = distributeMode === "horizontal" ? "width" : "height"; var sorted = vertices.slice().sort(function (a, b) { return a.geometry[axis] - b.geometry[axis]; }); var first = sorted[0].geometry[axis]; var last = Math.max.apply(Math, sorted.map(function (item) { return item.geometry[axis] + item.geometry[extent]; })); var totalSize = sorted.reduce(function (sum, item) { return sum + item.geometry[extent]; }, 0); var gap = (last - first - totalSize) / (sorted.length - 1); if (!Number.isFinite(gap) || gap < 0) throw new Error("Selected cells do not have enough space for even distribution"); var cursor = first; sorted.forEach(function (item) { var g = item.geometry.clone(); g[axis] = cursor; activeModel.setGeometry(item, g); cursor += g[extent] + gap; });
          }
        } catch (error) {
          var rollbackErrors = []; snapshots.forEach(function (snapshot) { try { activeModel.setGeometry(snapshot.cell, snapshot.geometry); } catch (rollbackError) { rollbackErrors.push(runtimeCellId(snapshot.cell) + ": " + (rollbackError && rollbackError.message ? String(rollbackError.message) : String(rollbackError))); } });
          if (rollbackErrors.length === 0 && !discardFailedNativeTransactionFromHistory(activeModel, undoCheckpoint)) rollbackErrors.push("Native Undo/Redo history could not be restored to its pre-alignment checkpoint.");
          if (rollbackErrors.length) throw new Error("The alignment/distribution operation failed and rollback was incomplete: " + (error && error.message ? String(error.message) : String(error)) + "; " + rollbackErrors.join("; "));
          throw error;
        } finally { activeModel.endUpdate(); }
        if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
        if (typeof activeGraph.refresh === "function") activeGraph.refresh();
        return;
      }
      if (request.cellId === "__active_page__" && selectionOperation === "cell:auto-layout") {
        var layoutPlan; try { layoutPlan = JSON.parse(String(request.value || "null")); } catch (_) { throw new Error("Studio auto-layout plan is not valid JSON"); }
        if (!layoutPlan || layoutPlan.pageId !== (currentPageId() || null)) throw new Error("The active Draw.io page changed after layout calculation. Re-run auto layout.");
        return applyNativeLayoutPlan(layoutPlan, activeGraph, activeModel);
      }
      var path = String(request.path || "");
      if (path === "cell:execute-script") throw new Error("Script execution has been removed; use the server-side XML patch capability.");
      var cell = activeModel.getCell(request.cellId);
      if (!cell) throw new Error("Selected Draw.io cell no longer exists");
      var requestedPage = request.pageId; var activePage = currentPageId();
      if (requestedPage && activePage && requestedPage !== activePage) throw new Error("The active Draw.io page changed before the property edit");
      var value = String(request.value == null ? "" : request.value);
      if (path === "cell:select") {
        if (isNativeStructuralRootOrLayer(cell, activeModel)) throw new Error("The Draw.io structural root and layer cells cannot be selected as diagram elements");
        if (typeof activeGraph.setSelectionCell !== "function") throw new Error("This Draw.io build does not expose cell selection");
        activeGraph.setSelectionCell(cell); if (typeof activeGraph.scrollCellToVisible === "function") activeGraph.scrollCellToVisible(cell);
        return { selected: true, cellId: cell.id };
      }
      activeModel.beginUpdate();
      try {
        if (path === "label") {
          var current = cell.value;
          if (current && typeof current === "object" && current.nodeType === 1) { var next = current.cloneNode(true); var labelKey = next.hasAttribute("label") ? "label" : "value"; next.setAttribute(labelKey, updateLabelMarkup(next.getAttribute(labelKey) || "", value)); activeModel.setValue(cell, next); }
          else activeModel.setValue(cell, updateLabelMarkup(current, value));
        } else if (path === "style") activeModel.setStyle(cell, value);
        else if (path.indexOf("style:") === 0) {
          var key = path.slice(6); var styles = String(activeModel.getStyle(cell) || "").split(";").filter(Boolean); var found = false; var normalized = value.toLowerCase(); var remove = value === "" || normalized === "0" || normalized === "false"; var flag = normalized === "1" || normalized === "true";
          var nextStyles = styles.map(function (part) { var index = part.indexOf("="); var partKey = index > 0 ? part.slice(0, index) : part; if (partKey !== key) return part; found = true; return remove ? "" : flag ? key : key + "=" + value; }).filter(Boolean);
          if (!found && !remove) nextStyles.push(flag ? key : key + "=" + value); activeModel.setStyle(cell, nextStyles.join(";") + (nextStyles.length ? ";" : ""));
        } else if (path.indexOf("point:") === 0 && cell.geometry) {
          var parts = path.split(":"); var index = Number(parts[1]); var axis = parts[2]; var numeric = Number(value); var geometry = cell.geometry.clone();
          if (!Number.isInteger(index) || index < 0 || !Number.isFinite(numeric) || (axis !== "x" && axis !== "y")) throw new Error("Connector control point coordinates must be numeric");
          var points = (geometry.points || []).map(function (point) { return point && typeof point.clone === "function" ? point.clone() : Object.assign({}, point); });
          if (!points[index]) throw new Error("Connector control point no longer exists"); points[index][axis] = numeric; geometry.points = points; activeModel.setGeometry(cell, geometry);
        } else if (path === "cell:add-node-after" || path === "cell:add-node-below") {
          if (!cell.vertex || !cell.geometry) throw new Error("The target must be a diagram vertex with geometry");
          var addRequest; try { addRequest = JSON.parse(value); } catch (_) { throw new Error("New-node payload is not valid JSON"); }
          if (!addRequest || typeof addRequest.label !== "string" || !addRequest.label.trim() || addRequest.label.length > 500) throw new Error("The new node needs a non-empty label of at most 500 characters");
          var nodeParent = cell.parent; if (!nodeParent) throw new Error("The target has no parent container in the native Draw.io model");
          var nodeGeometry = cell.geometry; var sourceX = Number(nodeGeometry.x); var sourceY = Number(nodeGeometry.y); var newWidth = Number(nodeGeometry.width); var newHeight = Number(nodeGeometry.height);
          if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY) || !Number.isFinite(newWidth) || newWidth <= 0 || !Number.isFinite(newHeight) || newHeight <= 0) throw new Error("The target does not have usable coordinates and geometry to derive the new node placement");
          var gridSpacing = Number(activeGraph.gridSize); if (!Number.isFinite(gridSpacing) || gridSpacing < 0) throw new Error("Draw.io grid spacing is unavailable; provide explicit placement coordinates in the native XML patch");
          var newX = path === "cell:add-node-after" ? sourceX + newWidth + gridSpacing : sourceX; var newY = path === "cell:add-node-after" ? sourceY : sourceY + newHeight + gridSpacing;
          var insertedNode = activeGraph.insertVertex(nodeParent, null, addRequest.label, newX, newY, newWidth, newHeight); if (!insertedNode) throw new Error("Draw.io did not create the new vertex");
          var insertedEdge = null;
          try { insertedEdge = activeGraph.insertEdge(nodeParent, null, "", cell, insertedNode); if (!insertedEdge) throw new Error("Draw.io did not create the connecting edge"); }
          catch (edgeError) { try { activeModel.remove(insertedNode); } catch (_) {} throw edgeError; }
                  } else if (path === "cell:delete") {
          if (isNativeStructuralRootOrLayer(cell, activeModel)) throw new Error("The Draw.io structural root and layer cells cannot be deleted");
          if (typeof activeGraph.removeCells === "function") activeGraph.removeCells([cell], true); else activeModel.remove(cell);
        } else if (path.indexOf("geometry:") === 0 && cell.geometry) {
          var geometryKey = path.slice(9); var nextGeometry = cell.geometry.clone();
          if (geometryKey === "size") { var dimensions = value.split(",").map(Number); if (dimensions.length !== 2 || dimensions.some(function (number) { return !Number.isFinite(number) || number < 1 || number > 10000; })) throw new Error("Size must contain width and height between 1 and 10000"); nextGeometry.width = dimensions[0]; nextGeometry.height = dimensions[1]; }
          else if (geometryKey === "translate") { var deltas = value.split(",").map(Number); if (deltas.length !== 2 || deltas.some(function (number) { return !Number.isFinite(number) || number < -10000 || number > 10000; })) throw new Error("Move delta must contain finite dx and dy between -10000 and 10000"); nextGeometry.x = Number(nextGeometry.x || 0) + deltas[0]; nextGeometry.y = Number(nextGeometry.y || 0) + deltas[1]; }
          else if (geometryKey === "relative") { var boolValue = value.toLowerCase(); if (["1", "0", "true", "false"].indexOf(boolValue) < 0) throw new Error("relative must be 1/0 or true/false"); nextGeometry.relative = boolValue === "1" || boolValue === "true"; }
          else if (["x", "y", "width", "height"].indexOf(geometryKey) >= 0) { var numberValue = Number(value); if (!Number.isFinite(numberValue)) throw new Error("Geometry must be numeric"); nextGeometry[geometryKey] = numberValue; }
          else throw new Error("Unsupported geometry property: " + geometryKey);
          activeModel.setGeometry(cell, nextGeometry);
        } else if (path.indexOf("cell:") === 0) {
          var cellKey = path.slice(5);
          if (["visible", "collapsed", "connectable"].indexOf(cellKey) >= 0) {
            var cellBool = value.toLowerCase(); if (["1", "0", "true", "false"].indexOf(cellBool) < 0) throw new Error(cellKey + " must be 1/0 or true/false"); var enabled = cellBool === "1" || cellBool === "true";
            if (cellKey === "visible") activeModel.setVisible(cell, enabled); else if (cellKey === "collapsed") activeModel.setCollapsed(cell, enabled); else setCellConnectable(cell, enabled);
          } else if (cellKey === "source" || cellKey === "target") {
            var terminal = value ? activeModel.getCell(value) : null; if (value && !terminal) throw new Error("No cell exists with id " + value); if (terminal && terminal.edge) throw new Error("A connector endpoint must be a vertex, not another connector"); if (terminal && (!terminal.geometry || !terminal.vertex)) throw new Error("A connector endpoint must be a connectable vertex"); activeModel.setTerminal(cell, terminal, cellKey === "source");
          } else if (cellKey === "parent") {
            if (isNativeStructuralRootOrLayer(cell, activeModel)) throw new Error("The Draw.io structural root and layer cells cannot be reparented");
            var parent = activeModel.getCell(value); if (!parent) throw new Error("No parent cell exists with id " + value);
            var ancestor = parent; while (ancestor) { if (ancestor === cell) throw new Error("A cell cannot be moved into itself or one of its descendants"); ancestor = ancestor.parent; }
            activeModel.add(parent, cell, activeModel.getChildCount(parent));
          } else throw new Error("Unsupported cell property: " + cellKey);
        } else if (path.indexOf("valueAttr:") === 0) {
          var attrKey = path.slice(10); var attrValue = cell.value; if (!attrValue || typeof attrValue !== "object" || attrValue.nodeType !== 1) throw new Error("This cell does not expose editable XML attributes"); var attrNext = attrValue.cloneNode(true); if (value === "") attrNext.removeAttribute(attrKey); else attrNext.setAttribute(attrKey, value); activeModel.setValue(cell, attrNext);
        } else throw new Error("Unsupported Draw.io property path: " + path);
      } finally { activeModel.endUpdate(); }
      if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
      if (typeof activeGraph.refresh === "function") activeGraph.refresh();
    }

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      var request;
      try { request = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch (_) { return; }
      if (!request || typeof request !== "object") return;
      if (!studioParentOrigin && request.event === "studioDrawioWelcome") {
        if (!event.origin || event.origin === "null") return;
        studioParentOrigin = event.origin;
        if (bridgeHelloTimer !== null) window.clearInterval(bridgeHelloTimer);
        bridgeHelloTimer = null;
        if (pendingBridgeReadyMessage) { publish(pendingBridgeReadyMessage); pendingBridgeReadyMessage = null; publishSelection(); }
        return;
      }
      if (!studioParentOrigin || event.origin !== studioParentOrigin) return;
      if (request.event === "studioHistoryCommand") {
        var historyAction = request.action; var undoManager = ui && ui.editor && ui.editor.undoManager;
        try {
          if (historyAction !== "undo" && historyAction !== "redo") throw new Error("Unsupported history command.");
          var available = historyState(); if (historyAction === "undo" && !available.canUndo) throw new Error("There is no native edit to undo."); if (historyAction === "redo" && !available.canRedo) throw new Error("There is no native edit to redo.");
          if (!undoManager || typeof undoManager[historyAction] !== "function") throw new Error("The native Draw.io history manager is unavailable.");
          if (historyAction === "undo" && typeof ui.undo === "function") ui.undo(); else if (historyAction === "redo" && typeof ui.redo === "function") ui.redo(); else undoManager[historyAction]();
          bindHistoryModelListener(); publishSelection(); publish({ event: "studioHistoryCommandResult", action: historyAction, success: true });
        } catch (historyError) { publishHistoryState(); publish({ event: "studioHistoryCommandResult", action: historyAction, success: false, error: historyError && historyError.message ? String(historyError.message) : String(historyError) }); }
      } else if (request.event === "studioNativePaletteRequest") {
        try { var paletteGraph = currentGraph(); var paletteModel = typeof paletteGraph.getModel === "function" ? paletteGraph.getModel() : model; var paletteResult = applyNativePalettePlan(request.plan, paletteGraph, paletteModel); bindHistoryModelListener(); publishSelection(); publish({ event: "studioNativePaletteResult", requestId: request.requestId, success: true, changedCells: paletteResult.changedCells, changedBackground: paletteResult.changedBackground }); }
        catch (paletteError) { publish({ event: "studioNativePaletteResult", requestId: request.requestId, success: false, error: paletteError && paletteError.message ? String(paletteError.message) : String(paletteError), rollbackConfirmed: Boolean(paletteError && paletteError.rollbackConfirmed) }); }
      } else if (request.event === "studioNativeLayoutRequest") {
        try { var layoutGraph = currentGraph(); var layoutModel = typeof layoutGraph.getModel === "function" ? layoutGraph.getModel() : model; var layoutResult = applyNativeLayoutPlan(request.plan, layoutGraph, layoutModel); publish({ event: "studioNativeLayoutResult", requestId: request.requestId, success: true, changedVertices: layoutResult.changedVertices, changedEdges: layoutResult.changedEdges, engine: layoutResult.engine, algorithm: layoutResult.algorithm }); }
        catch (layoutError) { publish({ event: "studioNativeLayoutResult", requestId: request.requestId, success: false, error: layoutError && layoutError.message ? String(layoutError.message) : String(layoutError), rollbackConfirmed: Boolean(layoutError && layoutError.rollbackConfirmed) }); }
      } else if (request.event === "studioRuntimeInspectRequest") {
        try { var inspection = inspectDrawioRuntime({ documentRevision: typeof request.documentRevision === "string" ? request.documentRevision : "", drawioVersion: typeof request.drawioVersion === "string" ? request.drawioVersion : "unknown" }); publish({ event: "studioRuntimeInspectResult", requestId: request.requestId, success: true, inspection: inspection }); }
        catch (inspectionError) { publish({ event: "studioRuntimeInspectResult", requestId: request.requestId, success: false, error: inspectionError && inspectionError.message ? String(inspectionError.message) : String(inspectionError) }); }
      } else if (request.event === "studioPropertyEditRequest") {
        try { editCell(request); publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: true, cellId: request.cellId, path: request.path }); }
        catch (error) { publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: false, cellId: request.cellId, path: request.path, error: error && error.message ? String(error.message) : String(error), errorStack: error && error.stack ? String(error.stack).slice(0, 8000) : null }); }
      } else if (request.event === "studioSetBackground") {
        var backgroundGraph = currentGraph();
        if (!hasOriginalBackground) { originalBackground = typeof request.restoreBackground === "string" ? request.restoreBackground : backgroundGraph.background; hasOriginalBackground = true; }
        backgroundGraph.background = request.restore ? (typeof request.restoreBackground === "string" ? request.restoreBackground : originalBackground) : request.background;
        if (backgroundGraph.view && typeof backgroundGraph.view.validateBackground === "function") backgroundGraph.view.validateBackground();
        if (typeof backgroundGraph.refresh === "function") backgroundGraph.refresh();
        publish({ event: "studioBackgroundResult", success: true });
      }
    });

    graph.getSelectionModel().addListener("change", publishSelection);
    if (typeof ui.addListener === "function") ui.addListener("pageSelected", function () { bindHistoryModelListener(); publishSelection(); });
    bindHistoryModelListener();
    pendingBridgeReadyMessage = { event: "studioBridgeReady", drawioVersion: "v32.0.2" };
    requestStudioHandshake();
    });
  }
  register();
})();
