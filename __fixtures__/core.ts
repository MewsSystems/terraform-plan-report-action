import type * as core from '@actions/core'
import { jest } from '@jest/globals'

export const debug = jest.fn<typeof core.debug>()
export const error = jest.fn<typeof core.error>()
export const info = jest.fn<typeof core.info>()
export const getInput = jest.fn<typeof core.getInput>()
export const setOutput = jest.fn<typeof core.setOutput>()
export const setFailed = jest.fn<typeof core.setFailed>()
export const warning = jest.fn<typeof core.warning>()

// `core.summary` is a chainable buffer; the mock returns itself so
// `summary.addRaw(...).write()` works in tests.
export const summary = {
  addRaw: jest.fn(() => summary),
  write: jest.fn(async () => summary)
}
