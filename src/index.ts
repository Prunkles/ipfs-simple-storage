import express from 'express'
import { createHelia, libp2pDefaults as createLibp2pDefaults } from 'helia'
import { FsDatastore } from 'datastore-fs'
import { FsBlockstore } from 'blockstore-fs'
import { createVerifiedFetch } from '@helia/verified-fetch'
import { CID } from 'multiformats'
import { Mutex } from 'async-mutex'
import { fileTypeFromBuffer } from '@sgtpooki/file-type'
import ipfsHttpGateway from './http-gateway/index.js'
import managerRouter from './manager/index.js'
import { bucketHas, ipfsSimpleStorageRouter } from './bucket/index.js'
import { v4 as uuidv4 } from "uuid";
import morgan from 'morgan'
import expressBasicAuth from 'express-basic-auth'
import { tcp } from '@libp2p/tcp'

function getConfig() {
    const apiBasicAuthTokens = (process.env.IPSS_API_BASIC_AUTH ?? 'user:password').split(':')
    const libp2p = {
        addressesListen: process.env.IPSS_LIBP2P_ADDRESSES_LISTEN?.split(','),
    }
    return {
        datastorePath: process.env.IPSS_DATASTORE_PATH ?? './datastore',
        blockstorePath: process.env.IPSS_BLOCKSTORE_PATH ?? './blockstore',
        apiPort: parseInt(process.env.IPSS_API_PORT ?? '45849'),
        apiAddress: process.env.IPSS_API_ADDRESS ?? '0.0.0.0',
        apiBasicAuthUsers: {
            [apiBasicAuthTokens[0]]: apiBasicAuthTokens[1],
        },
        libp2p,
    }
}
const config = getConfig()

const datastore = new FsDatastore(config.datastorePath)
const blockstore = new FsBlockstore(config.blockstorePath)

const libp2pDefaults = createLibp2pDefaults()
const helia = await createHelia({
    libp2p: {
        transports: [
            tcp()
        ],
        addresses: {
            listen: config.libp2p.addressesListen ?? libp2pDefaults.addresses?.listen,
        },
    },
    datastore,
    blockstore,
})

const log = helia.logger.forComponent('ipfs-simple-storage:index')

log('PeerId:', helia.libp2p.peerId)
for (let multiaddr of helia.libp2p.getMultiaddrs()) {
    log('Listening on', multiaddr.toString())
}

const verifiedFetch = await createVerifiedFetch(
    helia, {
        contentTypeParser: async (bytes) => {
            const result = await fileTypeFromBuffer(bytes)
            return result.mime
        }
    }
)

const app = express()
import 'express-async-errors'

app.use((req, res, next) => {
    (req as any).requestId = uuidv4()
    next()
})
morgan.token('requestId', req => (req as any).requestId)
app.use(morgan('--> :requestId ":method :url HTTP/:http-version"', {immediate: true}))
app.use(morgan('<-- :requestId ":method :url HTTP/:http-version" :status :res[content-length] - :response-time ms', {immediate: false}))


app.use('/ipfs/:cid', async (req, res, next) => {
    const cid = CID.parse(req.params.cid)
    // if (!await bucketHas(helia, cid)) {
    if (!await helia.blockstore.has(cid)) {
        res.status(404).send('Content not hosted')
        return
    }
    return next()
})

const mutex = new Mutex()

app.get('/healthz', (req, res) => {
    res.send('OK')
})

app.use(
    ipfsHttpGateway(helia, verifiedFetch)
)

app.use(
    expressBasicAuth({ users: config.apiBasicAuthUsers }),
    ipfsSimpleStorageRouter(helia, mutex)
)

app.use(
    '/mgr',
    expressBasicAuth({ users: config.apiBasicAuthUsers }),
    managerRouter(helia, mutex)
)


const port = config.apiPort
const address = config.apiAddress
const server = app.listen(port, address, () => {
    console.log(`Listening on ${address}:${port}`)
})

const shutdown = () => {
    console.log('Stopping helia')
    helia.stop().then(() => {
        console.log('Stopped helia')
    })
    console.log('Stopping express')
    server.close(() => {
        console.log('Stopped express')
    })
}
['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, shutdown)
})
