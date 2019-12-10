import Web3 from 'web3'
import dotenv from 'dotenv/config'
import { pRateLimit } from 'p-ratelimit'
import fs from 'fs'
import path from 'path'

import Dett from './lib/dett.js'
import LoomProvider from './loom.js'
import ShortURL from './lib/shortURL.js'
import db from '../models'

const { Article, CommentEvent, Height } = db

async function initalize() {
  await Article.sync()
  await CommentEvent.sync()
  await Height.sync()
}
initalize()

let dett = null
let loomWeb3 = null
const STEP = +process.env.STEP
let contractOwner = '0x2089f8ef830f4414143686ed0dfac4f5bc0ace04'

const rpcRateLimiter = pRateLimit({
  interval: 2500,
  rate: 1,
  concurrency: 1,
})

const addShortLink = async (tx) => {
  const shortLink = ShortURL.encode(dett.cacheweb3.utils.hexToNumber(tx.substr(0,10))).padStart(6,'0')
  const hexId = dett.cacheweb3.utils.padLeft(dett.cacheweb3.utils.toHex(shortLink), 64)

  const receipt = await dett.BBSCache.methods.link(tx, hexId).send({ from: contractOwner })
  if (receipt.status === true) {
    console.log('#Add ShortLink : '+tx+' '+shortLink)
    return hexId
  }

  return null
}

const syncLinks = async () => {
  const articals = await Article.findAll({ where: { short_link: null } })
  articals.forEach(async (artical) => {
    console.log(artical)
    const link = await dett.BBSCache.methods.links(artical.txid).call({ from: contractOwner })
    artical.short_link = loomWeb3.utils.hexToUtf8(link)
    artical.save()
  })

  console.log('#Sync Done')
}

const cacheArticles = async () => {
  await syncLinks()

  const previousHeight = (await Height.findOrCreate({ where: { tag: 'articles' } }))[0].dataValues.last_block_height
  let fromBlock = previousHeight ? previousHeight : dett.fromBlock
  let events = []

  for (let start = +fromBlock ; start < dett.currentHeight ; start+=(STEP+1)) {
    events = await dett.mergedEvents('Posted', events, start, start+STEP)
  }

  // ############################################
  // #### Generate Cache && Short link

  for (const [i, event] of events.entries()) {
    const tx = event.transactionHash
    const blockNumber = event.blockNumber.toString()
    let link = await dett.BBSCache.methods.links(tx).call({ from: contractOwner })

    // generate short links
    if (!+(link))
      link = await addShortLink(tx, blockNumber)

    await Article.findOrCreate({
      where: {
        block_number: blockNumber,
        txid: tx,
        short_link: loomWeb3.utils.hexToUtf8(link),
      }
    })
  }

  if (dett.currentHeight > 0)
    await Height.update({ last_block_height: dett.currentHeight - STEP }, { where: { tag: 'articles' } })
}

const cacheCommentEvents = async () => {
  const previousHeight = (await Height.findOrCreate({ where: { tag: 'comments' } }))[0].dataValues.last_block_height
  let fromBlock = previousHeight ? previousHeight : dett.fromBlock
  let events = []

  for (let start = +fromBlock ; start < dett.currentHeight ; start+=(STEP+1)) {
    events = await dett.mergedEvents('Replied', events, start, start+STEP)
  }

  events.forEach(async (event) => {
    await CommentEvent.findOrCreate({
      where: {
        block_number: event.blockNumber,
        txid: event.transactionHash,
        article_txid: event.returnValues.origin,
        event: JSON.stringify(event),
      }
    })
  })

  if (dett.currentHeight > 0)
    await Height.update({ last_block_height: dett.currentHeight - STEP }, { where: { tag: 'comments' } })
}

export const cache = async (updateAccess) => {
  // ############################################
  // #### init Dett
  
  const privateKeyString = process.env.LOOM_PRIVATEKEY

  const loomProvider =  new LoomProvider({
    chainId: 'default',
    writeUrl: `${process.env.RPC_URL}/rpc`,
    readUrl: `${process.env.RPC_URL}/query`,
    libraryName: 'web3.js',
    web3Api: Web3,
  })
  loomProvider.setNetworkOnly(privateKeyString)

  dett = new Dett()
  await dett.init(loomProvider)
  loomWeb3 = dett.loomProvider.library

  await cacheArticles()
  await cacheCommentEvents()
}

const main = async () => {
  await cache(false)
  process.exit(0)
}

if (!module.parent.parent)
  main()

// feature && issue
// 2.log
// 3.master env set cache network
// 4.compress porblem
