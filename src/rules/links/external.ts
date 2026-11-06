/** External links are checked for form only, with no request sent: a network failure says nothing about a commit. */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const IMAGE_DATA = /^data:image\//i;

// Plain HTTP, but not to this machine: a README's development server has no HTTPS to link to.
// `*.localhost` is this machine too, and it is how a server with several apps tells them apart.
export const DENIED_URLS = [/^http:\/\/(?!(?:(?:[a-z\d.-]*\.)?localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/?#]|$))/i];

/** What is wrong with an external link, or nothing. */
export function checkExternal(destination: string, denied: RegExp[]): string | null {
  let url;
  try {
    url = new URL(destination);
  } catch {
    return "not a valid URL";
  }
  if (IMAGE_DATA.test(destination)) return null;
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return `the protocol ${url.protocol} is not allowed`;
  const pattern = denied.find((re) => re.test(destination));
  return pattern ? `denied by ${String(pattern)}` : null;
}
