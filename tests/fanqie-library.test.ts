import { expect, it, vi } from 'vitest'
import { FanqieLibrary } from '../src/fanqie/library.ts'

it('serializes independent book writes, restores durable positions and does not commit a failed write', async () => {
  let state = { accounts: {} }
  const set = vi.fn(async value => { state = structuredClone(value) })
  const persistence = { get: () => state, set }
  const library = new FanqieLibrary(persistence)
  const position = { chapterId: '21', paragraphIndex: 2, remoteChapterId: '20', updatedAt: 1 }
  await Promise.all([library.save('a'.repeat(64), '12', position), library.save('a'.repeat(64), '13', { ...position, chapterId: '22' })])
  expect(new FanqieLibrary(persistence).position('a'.repeat(64), '12')).toEqual(position)
  expect(library.position('a'.repeat(64), '13')?.chapterId).toBe('22')
  set.mockRejectedValueOnce(new Error('disk full'))
  await expect(library.save('a'.repeat(64), '12', { ...position, paragraphIndex: 8 })).rejects.toThrow('disk full')
  expect(library.position('a'.repeat(64), '12')).toEqual(position)
  await library.save('b'.repeat(64), '12', { ...position, paragraphIndex: 3 })
  expect(library.position('a'.repeat(64), '12')).toEqual(position)
  const copy = library.position('b'.repeat(64), '12')!; copy.paragraphIndex = 99
  expect(library.position('b'.repeat(64), '12')?.paragraphIndex).toBe(3)
})
