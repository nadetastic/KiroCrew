import { describe, expect, it } from 'vitest'
import cases from '../../../test/fixtures/options_list.json'
import { deriveFollowUpOptions, parseOptions } from '../app-sdk/protocol'

describe('bulleted options trailer', () => {
  it.each(cases)('$name', ({ input, body, options }) => {
    expect(parseOptions(input)).toEqual({ text: body ?? input, options, multi: true })
  })

  it('offers the newest assistant list as multi-select chips only after streaming', () => {
    const messages = [{ role: 'assistant' as const, content: cases[0].input, cls: 'msg msg-a' }]
    expect(deriveFollowUpOptions(messages, false)).toMatchObject({
      followUpOptions: ['Alpha', 'Beta'], followUpMulti: true,
    })
    expect(deriveFollowUpOptions(messages, true).followUpOptions).toEqual([])
  })

  it('prefers a trailing list over an earlier canonical marker', () => {
    expect(parseOptions('Earlier.\n[OPTION: Old]\nChoose.\n[OPTIONS]\n- New')).toEqual({
      text: 'Earlier.\n\nChoose.', options: ['New'], multi: true,
    })
  })
})
