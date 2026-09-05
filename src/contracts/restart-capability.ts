export interface RestartPort {
  schedule(): void;
  acknowledge(): Promise<void>;
}

export type RestartCapability =
  | { readonly available: false }
  | { readonly available: true; readonly port: RestartPort };
