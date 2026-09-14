/** Типы для @resvg/resvg-wasm: пакет не экспортирует types в exports. */
declare module '@resvg/resvg-wasm' {
  export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
  export const initWasm: (module_or_path: Promise<InitInput> | InitInput) => Promise<void>;
  export const Resvg: new (svg: Uint8Array | string, options?: {
    font?: {
      fontBuffers?: Uint8Array[];
      loadSystemFonts?: boolean;
      defaultFontFamily?: string;
      serifFamily?: string;
    };
    fitTo?: { mode: 'original' } | { mode: 'width'; value: number } | { mode: 'height'; value: number } | { mode: 'zoom'; value: number };
    background?: string;
  }) => {
    render(): { asPng(): Uint8Array };
    free(): void;
  };
}

/** Статический импорт wasm-модуля (wrangler превращает его в WebAssembly.Module). */
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
