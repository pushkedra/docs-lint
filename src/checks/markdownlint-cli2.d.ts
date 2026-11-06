/** The package ships no types, and this is the one call made into it. */
declare module "markdownlint-cli2" {
  export function main(params: {
    argv: string[];
    logMessage: (message: string) => void;
    logError: (message: string) => void;
  }): Promise<number>;
}
