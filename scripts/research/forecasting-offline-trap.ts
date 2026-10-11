import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dgram from 'node:dgram'
import { getHeapStatistics } from 'node:v8'
import { readAvailablePinnedForecastArtifacts } from '../../lib/carry/pinnedForecastArtifacts.server'
readAvailablePinnedForecastArtifacts()
if (process.env.NODE_OPTIONS !== '--max-old-space-size=192' || getHeapStatistics().heap_size_limit > 256 * 1024 * 1024)
  throw Error('offline_heap_contract_mismatch:' + getHeapStatistics().heap_size_limit + ':' + (process.env.NODE_OPTIONS === '--max-old-space-size=192'))
const refused = () => { throw Error('offline_network_attempt') }
globalThis.fetch = refused
http.request = refused as typeof http.request
http.get = refused as typeof http.get
https.request = refused as typeof https.request
https.get = refused as typeof https.get
net.Socket.prototype.connect = refused as typeof net.Socket.prototype.connect
dgram.Socket.prototype.send = refused as typeof dgram.Socket.prototype.send
