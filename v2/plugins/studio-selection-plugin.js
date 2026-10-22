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
    var publish = function (message) {
      window.parent.postMessage(JSON.stringify(message), window.location.origin);
    };
    var currentPageId = function () {
      var page = ui.currentPage;
      var id = page && (typeof page.getId === "function" ? page.getId() : page.id);
      return typeof id === "string" && id ? id : null;
    };
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

    function updateLabelMarkup(source, value) {
      if (typeof source !== "string" || !/<[a-z][^>]*>/i.test(source)) return value;
      var parsed = new DOMParser().parseFromString(source, "text/html");
      var container = parsed.body.firstElementChild;
      if (!container) return value;
      container.textContent = value;
      return container.outerHTML;
    }

    function editCell(request) {
      // Draw.io can replace the active graph model when loading a new document.
      // Resolve it per request rather than retaining the model from plugin startup.
      var activeGraph = currentGraph();
      var activeModel = typeof activeGraph.getModel === "function" ? activeGraph.getModel() : model;
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
        var allCells = [];
        function collect(parent) {
          var count = activeModel.getChildCount(parent);
          for (var i = 0; i < count; i++) {
            var child = activeModel.getChildAt(parent, i);
            allCells.push(child);
            collect(child);
          }
        }
        collect(activeModel.getRoot());
        var snapshots = allCells.map(function (item) {
          return { cell: item, value: item.value && typeof item.value.cloneNode === "function" ? item.value.cloneNode(true) : item.value,
            style: item.style, geometry: item.geometry && item.geometry.clone(), source: item.source, target: item.target, parent: item.parent,
            index: item.parent && typeof item.parent.getIndex === "function" ? item.parent.getIndex(item) : -1,
            visible: item.visible, collapsed: item.collapsed, connectable: item.connectable };
        });
        var batchResults = [];
        var failedIndex = -1;
        activeModel.beginUpdate();
        try {
          operations.forEach(function (operation, index) {
            failedIndex = index;
            if (!operation || typeof operation.cellId !== "string" || typeof operation.path !== "string" ||
                typeof operation.value !== "string" || operation.path === "cell:batch" || operation.cellId === "__batch__" || operation.cellId === "__selection__") {
              throw new Error("Batch operation " + (index + 1) + " has an invalid or nested operation payload");
            }
            editCell({ cellId: operation.cellId, pageId: request.pageId, path: operation.path, value: operation.value });
            batchResults.push({ index: index + 1, cellId: operation.cellId, path: operation.path, value: operation.value, success: true });
          });
        } catch (error) {
          var rollbackErrors = [];
          snapshots.forEach(function (snapshot) {
            try {
              var item = snapshot.cell;
              if (activeModel.getCell(item.id) !== item && snapshot.parent) {
                activeModel.add(snapshot.parent, item, snapshot.index >= 0 ? snapshot.index : activeModel.getChildCount(snapshot.parent));
              }
              activeModel.setValue(item, snapshot.value);
              activeModel.setStyle(item, snapshot.style);
              if (snapshot.geometry) activeModel.setGeometry(item, snapshot.geometry);
              activeModel.setTerminal(item, snapshot.source || null, true);
              activeModel.setTerminal(item, snapshot.target || null, false);
              if (snapshot.parent && item.parent !== snapshot.parent) activeModel.add(snapshot.parent, item, snapshot.index >= 0 ? snapshot.index : activeModel.getChildCount(snapshot.parent));
              if (typeof snapshot.visible === "boolean") activeModel.setVisible(item, snapshot.visible);
              if (typeof snapshot.collapsed === "boolean") activeModel.setCollapsed(item, snapshot.collapsed);
              if (typeof snapshot.connectable === "boolean") activeModel.setConnectable(item, snapshot.connectable);
            } catch (rollbackError) {
              rollbackErrors.push({ cellId: snapshot.cell.id, error: rollbackError && rollbackError.message ? String(rollbackError.message) : String(rollbackError) });
            }
          });
          var failure = new Error("Batch rolled back after operation " + (failedIndex + 1) + " failed: " + (error && error.message ? error.message : String(error)));
          failure.batchResults = batchResults;
          failure.failedIndex = failedIndex;
          failure.rollbackErrors = rollbackErrors;
          throw failure;
        } finally { activeModel.endUpdate(); }
        if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
        if (typeof activeGraph.refresh === "function") activeGraph.refresh();
        return { batchResults: batchResults };
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
      var cell = activeModel.getCell(request.cellId);
      if (!cell) throw new Error("Selected Draw.io cell no longer exists");
      var requestedPage = request.pageId;
      var activePage = currentPageId();
      if (requestedPage && activePage && requestedPage !== activePage) {
        throw new Error("The active Draw.io page changed before the property edit");
      }
      var path = String(request.path || "");
      var value = String(request.value == null ? "" : request.value);
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
            else activeModel.setConnectable(cell, enabled);
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
      // editor dirty so the host's subsequent { action: "save" } request serializes them.
      if (ui.editor && typeof ui.editor.setModified === "function") ui.editor.setModified(true);
      if (typeof activeGraph.refresh === "function") activeGraph.refresh();
    }

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent || (event.origin !== window.location.origin && event.origin !== "null")) return;
      var request;
      try { request = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
      catch (_) { return; }
      if (!request || typeof request !== "object") return;
      if (request.event === "studioPropertyEditRequest") {
        try {
          var editResult = editCell(request);
          publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: true, cellId: request.cellId, path: request.path,
            batchResults: editResult && editResult.batchResults || null });
        } catch (error) {
          publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: false, cellId: request.cellId, path: request.path,
            error: error && error.message ? String(error.message) : String(error),
            batchResults: error && error.batchResults || null,
            failedIndex: Number.isInteger(error && error.failedIndex) ? error.failedIndex : null,
            rollbackErrors: error && error.rollbackErrors || [] });
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
    publish({ event: "studioBridgeReady" });
    publishSelection();
    });
  }
  register();
})();
