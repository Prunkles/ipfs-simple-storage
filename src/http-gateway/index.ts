// Based on https://github.com/ipfs/helia-http-gateway/blob/8c568ffb940846ef73e1d8b31f793e9d42d3c319/src/helia-http-gateway.ts

import type { Helia } from '@helia/interface'
import { type Request as ExpressRequest, type Response as ExpressResponse, Router } from 'express'
import type { Resource, VerifiedFetch, VerifiedFetchInit } from '@helia/verified-fetch'
import type { Logger } from '@libp2p/interface'

function pairwise<T>(arr: T[]): [T, T][] {
    return arr.reduce((result, value, index) => {
        if (index % 2 === 0) {
            result.push([value] as any)
        } else {
            result[result.length - 1].push(value)
        }
        return result
    }, <[T, T][]>[])
}

function expressRequestToVerifiedFetchResourceAndOptions(expressRequest: ExpressRequest): [Resource, VerifiedFetchInit?] {
    // const resource = `${expressRequest.protocol}://${expressRequest.hostname}:${expressRequest.socket.remotePort}${expressRequest.url}`
    const resource = `${expressRequest.url}`
    const options: VerifiedFetchInit = {
        headers: pairwise(expressRequest.rawHeaders)
    }
    return [resource, options]
}

async function sendResponseToExpressResponse(log: Logger, response: Response, expressResponse: ExpressResponse): Promise<void> {
    // if (!response.ok) {
    //     await reply.code(response.status).send(response.statusText)
    //     return
    // }

    const headers: Record<string, string> = {}
    for (let [headerName, headerValue] of response.headers.entries()) {
        headers[headerName] = headerValue
    }

    const bodyReader = response.body?.getReader()
    expressResponse.writeHead(response.status, headers)

    try {
        if (bodyReader) {
            let done = false
            let value: Uint8Array | undefined = undefined
            while (!done) {
                ({ done, value } = await bodyReader.read())
                if (value != null) {
                    expressResponse.write(value)
                }
            }
        }
    } catch (err) {
        log.error('Error reading response', err)
    } finally {
        expressResponse.end()
    }
}

export default function use(helia: Helia, verifiedFetch: VerifiedFetch) {
    const log = helia.logger.forComponent('ipfs-simple-storage:http-gateway')
    const router = Router()
    router.get(
        '/ipfs/:cid',
        async (req, res) => {
            const [ resource, options ] = expressRequestToVerifiedFetchResourceAndOptions(req)
            log('Requesting {0}', resource)
            const response = await verifiedFetch(resource, options)
            await sendResponseToExpressResponse(log, response, res)
        }
    )
    return router
}
