export interface RestartPort {
  schedule(): void;
  acknowledge(): Promise<void>;
}

export function createRestartPort(args: { dispose(): Promise<void>; exit(code: number): never }): RestartPort {
  let scheduled = false;
  let acknowledgement: Promise<void> | null = null;

  return {
    schedule(): void {
      scheduled = true;
    },
    acknowledge(): Promise<void> {
      if (!scheduled) throw new Error('Server restart has not been scheduled.');
      acknowledgement ??= args.dispose().then(() => args.exit(75));
      return acknowledgement;
    },
  };
}
