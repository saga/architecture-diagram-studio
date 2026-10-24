export interface StudioLocalFileWritable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface StudioLocalFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<StudioLocalFileWritable>;
  isSameEntry?(other: StudioLocalFileHandle): Promise<boolean>;
  queryPermission?(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
}

type FilePickerWindow = {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<StudioLocalFileHandle[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    excludeAcceptAllOption?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<StudioLocalFileHandle>;
};

const DRAWIO_FILE_TYPES = [{
  description: "Draw.io diagrams",
  accept: { "application/xml": [".drawio", ".dio", ".xml"] }
}];
const HANDLE_DATABASE = "architecture-diagram-studio-local-handles";
const HANDLE_STORE = "documents";

interface StoredHandle {
  documentId: string;
  handle: StudioLocalFileHandle;
  name: string;
  updatedAt: number;
}

function newDocumentId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "document-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

function openHandleDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HANDLE_STORE)) {
        database.createObjectStore(HANDLE_STORE, { keyPath: "documentId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local file handle registry"));
  });
}

function listStoredHandles(database: IDBDatabase): Promise<StoredHandle[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(HANDLE_STORE, "readonly").objectStore(HANDLE_STORE).getAll();
    request.onsuccess = () => resolve((request.result || []) as StoredHandle[]);
    request.onerror = () => reject(request.error || new Error("Could not read the local file handle registry"));
  });
}

function saveStoredHandle(database: IDBDatabase, value: StoredHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(HANDLE_STORE, "readwrite");
    transaction.objectStore(HANDLE_STORE).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not persist the local file handle"));
    transaction.onabort = () => reject(transaction.error || new Error("Saving the local file handle was aborted"));
  });
}

/** Opens the operating-system file picker provided by the browser. No path is exposed or needed. */
export async function chooseDrawioFile(): Promise<StudioLocalFileHandle | null> {
  const picker = window as unknown as FilePickerWindow;
  if (typeof picker.showOpenFilePicker !== "function") {
    throw new Error("This browser does not support the native file picker required to open a local Draw.io file. Use a current Chromium-based browser.");
  }
  const handles = await picker.showOpenFilePicker({
    multiple: false,
    excludeAcceptAllOption: false,
    types: DRAWIO_FILE_TYPES
  });
  return handles[0] || null;
}

/** Opens the browser's native Save dialog; the returned handle owns the export destination. */
export async function chooseDrawioSaveFile(suggestedName: string): Promise<StudioLocalFileHandle> {
  const picker = window as unknown as FilePickerWindow;
  if (typeof picker.showSaveFilePicker !== "function") {
    throw new Error("This browser does not support the native file save picker required to export a local Draw.io file. Use a current Chromium-based browser.");
  }
  return picker.showSaveFilePicker({
    suggestedName,
    excludeAcceptAllOption: false,
    types: DRAWIO_FILE_TYPES
  });
}

/** Read/write permission can be requested while the user is opening the selected file. */
export async function ensureDrawioWritePermission(handle: StudioLocalFileHandle): Promise<void> {
  if (!handle.queryPermission || !handle.requestPermission) return;
  const descriptor = { mode: "readwrite" as const };
  const current = await handle.queryPermission(descriptor);
  if (current === "granted") return;
  const requested = await handle.requestPermission(descriptor);
  if (requested !== "granted") {
    throw new Error("Write permission was not granted for " + handle.name + ". Reopen the file and allow editing.");
  }
}

/** Write only through the user-selected browser handle; Node.js never receives a path. */
export async function writeDrawioFile(handle: StudioLocalFileHandle, xml: string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(xml);
    await writable.close();
  } catch (error) {
    if (writable.abort) await writable.abort().catch(() => undefined);
    throw error;
  }
}

/**
 * Persist a stable document ID alongside the handle in IndexedDB. The ID scopes Node-side
 * history without exposing or guessing the original local path.
 */
export async function getLocalDocumentId(handle: StudioLocalFileHandle): Promise<string> {
  let database: IDBDatabase | null = null;
  try {
    database = await openHandleDatabase();
    const records = await listStoredHandles(database);
    for (const record of records) {
      if (!record.handle || typeof record.handle.isSameEntry !== "function") continue;
      try {
        if (await record.handle.isSameEntry(handle)) {
          await saveStoredHandle(database, { ...record, handle, name: handle.name, updatedAt: Date.now() });
          return record.documentId;
        }
      } catch {
        // A revoked or no-longer-accessible entry must not prevent opening another file.
      }
    }
    const documentId = newDocumentId();
    await saveStoredHandle(database, { documentId, handle, name: handle.name, updatedAt: Date.now() });
    return documentId;
  } catch {
    // File editing should remain available if IndexedDB is unavailable; history is then scoped
    // to this open session rather than silently falling back to filename-based identity.
    return newDocumentId();
  } finally {
    database?.close();
  }
}
