import type { Helia } from '@helia/interface'
import type { UnixFS } from '@helia/unixfs'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { CID } from 'multiformats'
import { Key } from 'interface-datastore'
import { Router } from 'express'
import { unixfs as createUnixfs } from '@helia/unixfs'
import multer from 'multer'
import { Mutex } from 'async-mutex'
import type { Logger } from '@libp2p/interface'
import { Err, Ok, Result } from 'ts-results-es'
import { NotFoundError } from 'ipfs-unixfs-exporter'

async function drainAsync(source: AsyncGenerator<unknown>): Promise<void> {
    for await (const _ of source) { }
}

function tryParseCID(input: string): Result<CID, Error> {
    try {
        return Ok(CID.parse(input))
    } catch (err) {
        return Err(err)
    }
}

function bucketLoggerName(): string { return `ipfs-simple-storage:bucket` }
const bucketRootKey = Key.withNamespaces(['ipfs-simple-storage', 'bucket-root'])

async function createBucketRoot(helia: Helia) {
    const emptyBucketRootCid = await createUnixfs(helia).addDirectory()
    await drainAsync(helia.pins.add(emptyBucketRootCid))
    await setBucketRoot(helia, emptyBucketRootCid)
    return emptyBucketRootCid
}

async function getBucketRoot(helia: Helia) {
    if (await helia.datastore.has(bucketRootKey)) {
        return CID.decode(await helia.datastore.get(bucketRootKey))
    } else {
        return await createBucketRoot(helia)
    }
}

async function setBucketRoot(helia: Helia, cid: CID) {
    await helia.datastore.put(bucketRootKey, cid.bytes)
}

async function updateBucketRoot(helia: Helia, fromCid: CID, toCid: CID) {
    helia.logger.forComponent(bucketLoggerName())('Updating bucket root from %s to %s', fromCid, toCid)
    await drainAsync(helia.pins.add(toCid, { metadata: { source: 'bucket-root' } }))
    await setBucketRoot(helia, toCid)
    await drainAsync(helia.pins.rm(fromCid))
}

export async function bucketHas(helia: Helia, cid: CID) {
    const unixfs = createUnixfs(helia)
    const bucketRootCid = await getBucketRoot(helia)
    try {
        await unixfs.stat(bucketRootCid, { path: cid.toString() })
        return true
    } catch (err) {
        if (err instanceof NotFoundError) {
            return false
        } else {
            throw err
        }
    }
}

type BucketAddError =
    | { kind: 'content-already-exists', cid: CID }

async function buckedAdd(helia: Helia, log: Logger, unixfs: UnixFS, bytes: Uint8Array): Promise<Result<{ itemCid: CID, newBucketRootCid: CID }, BucketAddError>> {
    log('Adding an item')
    const cid = await unixfs.addBytes(bytes, {
        cidVersion: 1,
        rawLeaves: true,
        chunker: fixedSize({ chunkSize: 1024 * 1024 }),
    })
    if (await bucketHas(helia, cid)) {
        log('Bucket already has item %s', cid)
        return Err({ kind: 'content-already-exists', cid })
    }
    log('Pinning item %s', cid)
    await drainAsync(helia.pins.add(cid, { metadata: { source: 'bucket-item' } }))

    const bucketRootCid = await getBucketRoot(helia)
    log('Copying item %s to bucket root %s', cid, bucketRootCid)
    const newBucketRootCid = await unixfs.cp(cid, bucketRootCid, cid.toString())
    await updateBucketRoot(helia, bucketRootCid, newBucketRootCid)

    return Ok({
        itemCid: cid,
        newBucketRootCid: newBucketRootCid,
    })
}

type BucketRemoveError =
    | { kind: 'item-does-not-exists', cid: CID }

async function bucketRemove(helia: Helia, log: Logger, unixfs: UnixFS, cid: CID): Promise<Result<{ newBucketRootCid: CID }, BucketRemoveError>> {
    log('Removing item %s', cid)
    if (!await bucketHas(helia, cid)) {
        log('Item %s does not exist', cid)
        return Err({ kind: 'item-does-not-exists', cid })
    }

    const bucketRootCid = await getBucketRoot(helia)
    log('Removing item %s from bucket root %s', cid, bucketRootCid)
    const newBucketRootCid = await unixfs.rm(bucketRootCid, cid.toString())
    await updateBucketRoot(helia, bucketRootCid, newBucketRootCid)

    await drainAsync(helia.pins.rm(cid))
    return Ok({ newBucketRootCid })
}

async function bucketList(helia: Helia, log: Logger, unixfs: UnixFS): Promise<{ bucketRootCid: CID, itemCids: CID[] }> {
    const bucketRootCid = await getBucketRoot(helia)
    log('Listing items in bucket root %s', bucketRootCid)
    const itemCids: CID[] = []
    for await (const entry of unixfs.ls(bucketRootCid)) {
        itemCids.push(entry.cid)
    }
    log('Listed %i items in bucket root %s', itemCids.length, bucketRootCid)
    return {
        bucketRootCid,
        itemCids,
    }
}

export function ipfsSimpleStorageRouter(helia: Helia, mutex: Mutex) {
    const upload = multer()
    const unixfs = createUnixfs(helia)
    const router = Router()
    const log = helia.logger.forComponent(bucketLoggerName())
    router.post('/add',
        upload.single('file'),
        async (req, res) => {
            const r = await mutex.runExclusive(async () => {
                return await buckedAdd(helia, log, unixfs, req.file!.buffer)
            })
            if (r.isErr()) {
                res.status(409).contentType('application/problem+json').json({
                    status: 409,
                    type: '/problems/content-already-exists',
                    cid: r.error.cid
                })
            } else {
                res.status(200).json({
                    itemCid: r.value.itemCid,
                    newBucketRootCid: r.value.newBucketRootCid,
                })
            }
        }
    )
    router.post('/remove/:cid',
        async (req, res) => {
            const cidResult = tryParseCID(req.params.cid)
            if (cidResult.isErr()) {
                res.status(401).contentType('application/problem+json').json({
                    status: 401,
                    type: '/problems/invalid-cid',
                    error: cidResult.error
                })
                return
            }
            const cid = cidResult.value
            const r = await mutex.runExclusive(async () => {
                return await bucketRemove(helia, log, unixfs, cid)
            })
            if (r.isErr()) {
                res.status(404).contentType('application/problem+json').json({
                    status: 404,
                    type: '/problems/item-does-not-exist',
                    cid: r.error.cid
                })
                return
            }
            res.status(200).json({
                newBucketRootCid: r.value.newBucketRootCid
            })
        }
    )
    router.get('/list',
        async (req, res) => {
            const r = await mutex.runExclusive(async () => {
                return await bucketList(helia, log, unixfs)
            })
            res.status(200).json({
                bucketRootCid: r.bucketRootCid,
                itemCids: r.itemCids,
            })
        }
    )
    router.post('/set-bucket-root/:cid',
        async (req, res) => {
            const cid = tryParseCID(req.params.cid).unwrap()
            await mutex.runExclusive(async () => {
                log('Setting bucket root to %s', cid)
                const bucketRootCid = await getBucketRoot(helia)
                await updateBucketRoot(helia, bucketRootCid, cid)
                log('Setted bucket root to %s', cid)
            })
            res.status(200).json({})
        }
    )
    return router
}
