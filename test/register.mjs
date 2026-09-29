// `node --import ./test/register.mjs test/behaviour.test.mjs`
import { register } from 'node:module'
register('./stub-loader.mjs', import.meta.url)
