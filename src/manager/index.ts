import { Router } from 'express'
import type { Helia, Pin } from '@helia/interface'
import { CID } from 'multiformats'
import { Mutex } from 'async-mutex'
import { car as createCar } from '@helia/car'
import { CarReader } from '@ipld/car'
import multer from 'multer'

export default function router(helia: Helia, mutex: Mutex) {
    const upload = multer()
    const logGc = helia.logger.forComponent('ipfs-simple-storage:manager:gc')
    const logPins = helia.logger.forComponent('ipfs-simple-storage:manager:pins')
    const logCar = helia.logger.forComponent('ipfs-simple-storage:manager:car')
    const router = Router()
    const car = createCar(helia)
    router.post('/gc', async (req, res) => {
        const deletedCids: CID[] = []
        let errors: Error[] = []
        await mutex.runExclusive(async () => {
            logGc('Starting gc')
            await helia.gc({
                onProgress: (event) => {
                    if (event.type === 'helia:gc:deleted') {
                        deletedCids.push(event.detail)
                    } else if (event.type === 'helia:gc:error') {
                        errors.push(event.detail)
                    }
                },
            })
            logGc('Deleted %i cids', deletedCids.length)
            if (errors.length > 0) {
                logGc.error('%i deletion failures', errors.length)
            }
        }, 80)
        if (errors.length > 0) {
            res.status(500).json({ errors, deletedCids })
        } else {
            res.status(200).json({ deletedCids })
        }
    })
    router.post('/pins/ls', async (req, res) => {
        const pins: Pin[] = []
        await mutex.runExclusive(async () => {
            for await (const pin of helia.pins.ls()) {
                pins.push(pin)
            }
        })
        res.status(200).json({ pins })
    })
    router.post('/pins/rm/:cid', async (req, res) => {
        const cid = CID.parse(req.params.cid)
        const unpinnedCids: CID[] = []
        await mutex.runExclusive(async () => {
            logPins('Removing pin for %s', cid)
            for await (const unpinnedCid of helia.pins.rm(cid)) {
                unpinnedCids.push(unpinnedCid)
            }
            logPins('Unpinned %i cids', unpinnedCids.length)
        })
        res.status(200).json({
            unpinnedCids,
        })
    })
    router.post('/car/import',
        upload.single('car'),
        async (req, res) => {
            const stream = req.file?.stream!
            const carReader = await CarReader.fromIterable(stream)
            await mutex.runExclusive(async () => {
                logCar('Importing a car')
                await car.import(carReader)
                logCar('Imported car')
            })
            res.status(200).json({})
        }
    )
    return router
}
