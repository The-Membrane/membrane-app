

export function setCookie(name: string, value: string, days: number): void {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + value + expires + "; path=/";
  console.log("setting cookie", document.cookie)
}

export function getCookie(name: string): string | null {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  console.log("getting cookie", document.cookie)
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i].trim();
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

export function deleteCookie(name: string): void {
  document.cookie = name + '=; Max-Age=-99999999;';
}

export function setSecureCookie(name: string, value: string, days: number): void {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + value + expires + "; path=/; Secure; HttpOnly";
}

export function setObjectCookie(name: string, value: T, days: number): void {
  const stringValue = JSON.stringify(value);
  setCookie(name, stringValue, days);
}

export function getObjectCookie(name: string): T | null {
  const value = getCookie(name);
  if (value) {
    return JSON.parse(value) as T;
  }
  return null;
}

export function getCookieExpirationDate(name: string) {
  const cookie = document.cookie
    .split('; ')
    .find(row => row.startsWith(name + '='));

  if (!cookie) return null;

  // Get all cookies and find the target cookie's full string
  const allCookies = document.cookie.split('; ');
  const cookieString = allCookies.find(c => c.includes(`${name}=`));

  if (!cookieString) return null;

  // Extract expiration from cookie string
  const match = cookieString.match(/expires=([^;]+)/);
  if (match && match[1]) {
    return new Date(match[1]);
  }

  // Alternative method: Parse Set-Cookie header
  // Note: This only works if you have access to the response headers
  const cookieHeader = document.cookie;
  const expires = cookieHeader.match(/expires=([^;]+)/);

  return expires ? new Date(expires[1]) : null;
}