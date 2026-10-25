/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NATIVE_SCRIPT_WATCHDOG_TIMEOUT_MS?: string;
}

declare module "cytoscape-fcose" {
  const register: (cytoscape: any) => void;
  export default register;
}
