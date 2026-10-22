/* Studio's local Draw.io bridge. Loaded from the pinned, same-origin local bundle. */
(function () {
  if (!window.Draw || typeof window.Draw.loadPlugin !== "function") {
    console.error("[studio-drawio-bridge] Draw.loadPlugin is unavailable");
    return;
  }

  window.Draw.loadPlugin(function (ui) {
    var graph = ui && ui.editor && ui.editor.graph;
    var model = graph && (typeof graph.getModel === "function" ? graph.getModel() : graph.model);
    if (!graph || !model || typeof graph.getSelectionModel !== "function") {
      console.error("[studio-drawio-bridge] Native graph model is unavailable");
      return;
    }

    function pageId() {
      var page = ui.currentPage;
      var id = page && (typeof page.getId === "function" ? page.getId() : page.id);
      return typeof id === "string" && id ? id : null;
    }

    function publishSelection() {
      var cells = typeof graph.getSelectionCells === "function" ? graph.getSelectionCells() : [];
      var cell = cells && cells.length ? cells[0] : null;
      var id = cell && (typeof cell.getId === "function" ? cell.getId() : cell.id);
      window.parent.postMessage(JSON.stringify({
        event: "studioSelectionChanged",
        cellId: typeof id === "string" && id ? id : null,
        pageId: pageId()
      }), window.location.origin);
    }

    function applyCellEdit(edit) {
      if (!edit || typeof edit.cellId !== "string" || typeof edit.path !== "string" ||
          typeof edit.value !== "string" || typeof edit.requestId !== "number") {
        return { ok: false, error: "Malformed cell property edit request" };
      }

      var activePageId = pageId();
      if (edit.pageId && activePageId && edit.pageId !== activePageId) {
        return { ok: false, stalePage: true, error: "The active Draw.io page changed before the property edit" };
      }

      var cell = model.getCell(edit.cellId);
      if (!cell) return { ok: false, error: "The selected cell no longer exists: " + edit.cellId };

      var path = edit.path;
      var value = edit.value;
      try {
        model.beginUpdate();
        try {
          if (path === "label") {
            var current = cell.value;
            if (current && typeof current === "object" && current.nodeType === 1) {
              var nextValue = current.cloneNode(true);
              nextValue.setAttribute(nextValue.hasAttribute("label") ? "label" : "value", value);
              model.setValue(cell, nextValue);
            } else model.setValue(cell, value);
          } else if (path === "style") {
            model.setStyle(cell, value);
          } else if (path.indexOf("style:") === 0) {
            var styleKey = path.slice("style:".length);
            var styles = String(model.getStyle(cell) || "").split(";").filter(Boolean);
            var found = false;
            var normalized = value.toLowerCase();
            var remove = value === "" || normalized === "0" || normalized === "false";
            var flag = normalized === "1" || normalized === "true";
            var updatedStyles = styles.map(function (part) {
              var index = part.indexOf("=");
              var partKey = index > 0 ? part.slice(0, index) : part;
              if (partKey !== styleKey) return part;
              found = true;
              return remove ? "" : flag ? styleKey : styleKey + "=" + value;
            }).filter(Boolean);
            if (!found && !remove) updatedStyles.push(flag ? styleKey : styleKey + "=" + value);
            model.setStyle(cell, updatedStyles.join(";") + (updatedStyles.length ? ";" : ""));
          } else if (path.indexOf("point:") === 0 && cell.geometry) {
            var pointParts = path.split(":");
            var pointIndex = Number(pointParts[1]);
            var pointAxis = pointParts[2];
            var pointNumber = Number(value);
            var pointGeometry = cell.geometry.clone();
            if (!Number.isInteger(pointIndex) || pointIndex < 0 || !Number.isFinite(pointNumber) ||
                (pointAxis !== "x" && pointAxis !== "y")) {
              throw new Error("Connector control point coordinates must be numeric");
            }
            var points = (pointGeometry.points || []).map(function (point) {
              return typeof point.clone === "function" ? point.clone() : Object.assign({}, point);
            });
            if (!points[pointIndex]) throw new Error("Connector control point no longer exists");
            points[pointIndex][pointAxis] = pointNumber;
            pointGeometry.points = points;
            model.setGeometry(cell, pointGeometry);
          } else if (path.indexOf("geometry:") === 0 && cell.geometry) {
            var geometryKey = path.slice("geometry:".length);
            var geometry = cell.geometry.clone();
            if (geometryKey === "relative") {
              var relativeValue = value.toLowerCase();
              if (["1", "0", "true", "false"].indexOf(relativeValue) < 0) {
                throw new Error("relative must be 1/0 or true/false");
              }
              geometry.relative = relativeValue === "1" || relativeValue === "true";
            } else if (["x", "y", "width", "height"].indexOf(geometryKey) >= 0) {
              var numeric = Number(value);
              if (!Number.isFinite(numeric)) throw new Error("Geometry must be numeric");
              geometry[geometryKey] = numeric;
            } else {
              throw new Error("Unsupported geometry property: " + geometryKey);
            }
            model.setGeometry(cell, geometry);
          } else if (path.indexOf("cell:") === 0) {
            var key = path.slice("cell:".length);
            if (["visible", "collapsed", "connectable"].indexOf(key) >= 0) {
              var flagValue = value.toLowerCase();
              if (["1", "0", "true", "false"].indexOf(flagValue) < 0) {
                throw new Error(key + " must be 1/0 or true/false");
              }
              var enabled = flagValue === "1" || flagValue === "true";
              if (key === "visible") model.setVisible(cell, enabled);
              else if (key === "collapsed") model.setCollapsed(cell, enabled);
              else model.setConnectable(cell, enabled);
            } else if (key === "source" || key === "target") {
              var terminal = value ? model.getCell(value) : null;
              if (value && !terminal) throw new Error("No cell exists with id " + value);
              model.setTerminal(cell, terminal, key === "source");
            } else if (key === "parent") {
              if (cell.id === "0" || cell.id === "1") throw new Error("The Draw.io root and default layer cannot be reparented");
              var parent = model.getCell(value);
              if (!parent) throw new Error("No parent cell exists with id " + value);
              var ancestor = parent;
              while (ancestor) {
                if (ancestor === cell) throw new Error("A cell cannot be moved into itself or one of its descendants");
                ancestor = ancestor.parent;
              }
              model.add(parent, cell, model.getChildCount(parent));
            } else {
              throw new Error("Unsupported cell property: " + key);
            }
          } else if (path.indexOf("valueAttr:") === 0) {
            var attributeKey = path.slice("valueAttr:".length);
            var objectValue = cell.value;
            if (objectValue && typeof objectValue === "object" && objectValue.nodeType === 1) {
              var nextObject = objectValue.cloneNode(true);
              if (value === "") nextObject.removeAttribute(attributeKey);
              else nextObject.setAttribute(attributeKey, value);
              model.setValue(cell, nextObject);
            } else {
              throw new Error("Custom attributes are only editable on Draw.io object cells");
            }
          } else {
            throw new Error("Unsupported property path: " + path);
          }
        } finally {
          model.endUpdate();
        }
        if (typeof graph.refresh === "function") graph.refresh();
        return { ok: true, pageId: activePageId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // The host uses this bridge for edits because Draw.io deliberately keeps editorUi
    // private rather than exposing it as window.editorUi.
    window.studioDrawioBridge = {
      version: 1,
      applyCellEdit: applyCellEdit
    };

    graph.getSelectionModel().addListener("change", publishSelection);
    if (typeof ui.addListener === "function") ui.addListener("pageSelected", publishSelection);
    publishSelection();
  });
})();
