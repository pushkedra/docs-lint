/** How a run ends. */

export function fail(message: string): never {
  console.error(`docs-lint: ${message}`);
  process.exit(2);
}

/** Exit once stdout has drained: `process.exit` drops whatever a pipe has not taken yet. */
export async function finish(code: number): Promise<never> {
  await new Promise((drained) => process.stdout.write("", drained));
  process.exit(code);
}
