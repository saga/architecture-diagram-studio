declare module "picomatch" {
  export interface PicomatchOptions {
    dot?: boolean;
  }

  export type PicomatchMatcher = (input: string) => boolean;

  export default function picomatch(pattern: string, options?: PicomatchOptions): PicomatchMatcher;
}
