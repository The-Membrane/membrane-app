/** A minimal NextApiResponse stand-in that records status, headers and body. */
export function mockRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v
      return this
    },
    status(c: number) {
      this.statusCode = c
      return this
    },
    send(b: unknown) {
      this.body = b
      return this
    },
    json(b: unknown) {
      this.headers['content-type'] ??= 'application/json'
      this.body = b
      return this
    },
  }
  return res
}
