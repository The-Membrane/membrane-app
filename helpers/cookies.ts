function setCookie(name: string, value: string, days: number): void {
    let expires = "";
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + value + expires + "; path=/";
    console.log("setting cookie", document.cookie)
  }

function getCookie(name: string): string | null {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for(let i=0;i < ca.length;i++) {
    let c = ca[i].trim();
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

function deleteCookie(name: string): void {
    document.cookie = name + '=; Max-Age=-99999999;';
}

function setSecureCookie(name: string, value: string, days: number): void {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + value + expires + "; path=/; Secure; HttpOnly";
}

function setObjectCookie(name: string, value: T, days: number): void {
  const stringValue = JSON.stringify(value);
  setCookie(name, stringValue, days);
}

function getObjectCookie(name: string): T | null {
  const value = getCookie(name);
  if (value) {
    return JSON.parse(value) as T;
  }
  return null;
}