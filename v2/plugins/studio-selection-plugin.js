/* Studio's local Draw.io embed bridge. Loaded from the pinned local bundle. */
(function () {
  if (!window.Draw || typeof window.Draw.loadPlugin !== "function") {
    console.error("[studio-drawio-bridge] Draw.loadPlugin is unavailable");
    return;
  }

  window.Draw.loadPlugin(function (ui) {
    var graph = ui && ui.editor && ui.editor.graph;
    if (!graph || typeof graph.getSelectionModel !== "function") {
      console.error("[studio-drawio-bridge] Native graph selection model is unavailable");
      return;
    }

    var publishSelection = function () {
      var cells = typeof graph.getSelectionCells === "function" ? graph.getSelectionCells() : [];
      var cell = cells && cells.length ? cells[0] : null;
      var page = ui.currentPage;
      var cellId = cell && (typeof cell.getId === "function" ? cell.getId() : cell.id);
      var pageId = page && (typeof page.getId === "function" ? page.getId() : page.id);

      window.parent.postMessage(JSON.stringify({
        event: "studioSelectionChanged",
        cellId: typeof cellId === "string" && cellId ? cellId : null,
        pageId: typeof pageId === "string" && pageId ? pageId : null
      }), window.location.origin);
    };

    graph.getSelectionModel().addListener("change", publishSelection);
    if (typeof ui.addListener === "function") {
      ui.addListener("pageSelected", publishSelection);
    }
    publishSelection();
  });
})();
