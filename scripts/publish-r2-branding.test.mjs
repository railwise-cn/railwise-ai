import assert from 'node:assert/strict'
import test from 'node:test'
import productBrand from '../src/shared/product-brand.json' with { type: 'json' }
import { _internals } from './publish-r2.mjs'

test('R2 manifests use the public RailWise AI product identity', () => {
  assert.equal(_internals.productName, productBrand.platform)
  assert.equal(_internals.productName, 'RailWise AI')
})
