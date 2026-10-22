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
      var cells = typeof graph.getSelectionCells === "function" ? graph.getSelectionCells() : [];
      var cell = cells && cells.length ? cells[0] : null;
      var id = cell && (typeof cell.getId === "function" ? cell.getId() : cell.id);
      publish({
        event: "studioSelectionChanged",
        cellId: typeof id === "string" && id ? id : null,
        pageId: currentPageId()
      });
    };

    function editCell(request) {
      var cell = model.getCell(request.cellId);
      if (!cell) throw new Error("Selected Draw.io cell no longer exists");
      var requestedPage = request.pageId;
      var activePage = currentPageId();
      if (requestedPage && activePage && requestedPage !== activePage) {
        throw new Error("The active Draw.io page changed before the property edit");
      }
      var path = String(request.path || "");
      var value = String(request.value == null ? "" : request.value);
      model.beginUpdate();
      try {
        if (path === "label") {
          var current = cell.value;
          if (current && typeof current === "object" && current.nodeType === 1) {
            var next = current.cloneNode(true);
            next.setAttribute(next.hasAttribute("label") ? "label" : "value", value);
            model.setValue(cell, next);
          } else model.setValue(cell, value);
        } else if (path === "style") {
          model.setStyle(cell, value);
        } else if (path.indexOf("style:") === 0) {
          var key = path.slice(6);
          var styles = String(model.getStyle(cell) || "").split(";").filter(Boolean);
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
          model.setStyle(cell, nextStyles.join(";") + (nextStyles.length ? ";" : ""));
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
          model.setGeometry(cell, geometry);
        } else if (path.indexOf("geometry:") === 0 && cell.geometry) {
          var geometryKey = path.slice(9);
          var nextGeometry = cell.geometry.clone();
          if (geometryKey === "relative") {
            var boolValue = value.toLowerCase();
            if (["1", "0", "true", "false"].indexOf(boolValue) < 0) throw new Error("relative must be 1/0 or true/false");
            nextGeometry.relative = boolValue === "1" || boolValue === "true";
          } else if (["x", "y", "width", "height"].indexOf(geometryKey) >= 0) {
            var numberValue = Number(value);
            if (!Number.isFinite(numberValue)) throw new Error("Geometry must be numeric");
            nextGeometry[geometryKey] = numberValue;
          } else throw new Error("Unsupported geometry property: " + geometryKey);
          model.setGeometry(cell, nextGeometry);
        } else if (path.indexOf("cell:") === 0) {
          var cellKey = path.slice(5);
          if (["visible", "collapsed", "connectable"].indexOf(cellKey) >= 0) {
            var cellBool = value.toLowerCase();
            if (["1", "0", "true", "false"].indexOf(cellBool) < 0) throw new Error(cellKey + " must be 1/0 or true/false");
            var enabled = cellBool === "1" || cellBool === "true";
            if (cellKey === "visible") model.setVisible(cell, enabled);
            else if (cellKey === "collapsed") model.setCollapsed(cell, enabled);
            else model.setConnectable(cell, enabled);
          } else if (cellKey === "source" || cellKey === "target") {
            var terminal = value ? model.getCell(value) : null;
            if (value && !terminal) throw new Error("No cell exists with id " + value);
            model.setTerminal(cell, terminal, cellKey === "source");
          } else if (cellKey === "parent") {
            if (cell.id === "0" || cell.id === "1") throw new Error("The Draw.io root and default layer cannot be reparented");
            var parent = model.getCell(value);
            if (!parent) throw new Error("No parent cell exists with id " + value);
            var ancestor = parent;
            while (ancestor) {
              if (ancestor === cell) throw new Error("A cell cannot be moved into itself or one of its descendants");
              ancestor = ancestor.parent;
            }
            model.add(parent, cell, model.getChildCount(parent));
          } else throw new Error("Unsupported cell property: " + cellKey);
        } else if (path.indexOf("valueAttr:") === 0) {
          var attrKey = path.slice(10);
          var attrValue = cell.value;
          if (!attrValue || typeof attrValue !== "object" || attrValue.nodeType !== 1) {
            throw new Error("This cell does not expose editable XML attributes");
          }
          var attrNext = attrValue.cloneNode(true);
          if (value === "") attrNext.removeAttribute(attrKey); else attrNext.setAttribute(attrKey, value);
          model.setValue(cell, attrNext);
        } else throw new Error("Unsupported Draw.io property path: " + path);
      } finally {
        model.endUpdate();
      }
      if (typeof graph.refresh === "function") graph.refresh();
    }

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent || (event.origin !== window.location.origin && event.origin !== "null")) return;
      var request;
      try { request = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
      catch (_) { return; }
      if (!request || typeof request !== "object") return;
      if (request.event === "studioPropertyEditRequest") {
        try {
          editCell(request);
          publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: true, cellId: request.cellId, path: request.path });
        } catch (error) {
          publish({ event: "studioPropertyEditResult", requestId: request.requestId, success: false, cellId: request.cellId, path: request.path,
            error: error && error.message ? String(error.message) : String(error) });
        }
      } else if (request.event === "studioSetBackground") {
        if (!hasOriginalBackground) {
          originalBackground = graph.background;
          hasOriginalBackground = true;
        }
        graph.background = request.restore ? originalBackground : request.background;
        if (graph.view && typeof graph.view.validateBackground === "function") graph.view.validateBackground();
        if (typeof graph.refresh === "function") graph.refresh();
        publish({ event: "studioBackgroundResult", success: true });
      }
    });

    var savedBackground = null;
    window.addEventListener("message", function (event) {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      var message = event.data;
      if (typeof message === "string") {
        try { message = JSON.parse(message); } catch (_) { return; }
      }
      if (!message || message.event !== "studioSetBackground") return;
      if (message.restore === true) {
        var restoreBackground = typeof message.restoreBackground === "string" ? message.restoreBackground : null;
        graph.background = restoreBackground || savedBackground || graph.background;
        savedBackground = null;
      } else if (typeof message.background === "string") {
        if (savedBackground === null) savedBackground = graph.background;
        graph.background = message.background;
      }
      if (graph.view && typeof graph.view.validateBackground === "function") graph.view.validateBackground();
      if (typeof graph.refresh === "function") graph.refresh();
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
