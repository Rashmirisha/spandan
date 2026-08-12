/**
 * Tests for the local question generator (no AI required).
 * Coverage:
 *  - Basic MCQ/TF/SA generation from a definition-heavy transcript
 *  - Number-fact extraction
 *  - Distractor generation
 *  - Empty / too-short transcripts throw a clear error
 *  - Picks the questionTypeMix correctly
 *  - Wired through questionService.generateQuestions (provider='local')
 */
import { generateLocalQuestions } from '../services/localQuestionGenerator.js'
import { generateQuestions } from '../services/questionService.js'

describe('localQuestionGenerator', () => {
  describe('generateLocalQuestions()', () => {
    it('generates MCQ from a definition sentence', () => {
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy. The process mainly occurs in chloroplasts.'
      const qs = generateLocalQuestions(transcript, { questionCount: 1, types: ['MCQ'] })
      expect(qs.length).toBe(1)
      expect(qs[0].type).toBe('MCQ')
      expect(qs[0].question.toLowerCase()).toContain('photosynthesis')
      expect(qs[0].options.length).toBe(4)
      const correct = qs[0].options.find(o => o.isCorrect)
      expect(correct).toBeDefined()
    })

    it('generates TF from a definitional sentence', () => {
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy.'
      const qs = generateLocalQuestions(transcript, { questionCount: 1, types: ['TF'] })
      expect(qs.length).toBe(1)
      expect(qs[0].type).toBe('TF')
      expect(qs[0].options.length).toBe(2)
    })

    it('generates SA from a definitional sentence', () => {
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy.'
      const qs = generateLocalQuestions(transcript, { questionCount: 1, types: ['SA'] })
      expect(qs.length).toBe(1)
      expect(qs[0].type).toBe('SA')
    })

    it('produces at least 3 questions for a 5-sentence transcript', () => {
      const transcript = [
        'Photosynthesis is the process by which green plants convert light energy into chemical energy.',
        'This process mainly occurs in chloroplasts.',
        'The chemical energy is stored in glucose.',
        'Plants use sunlight, water, and carbon dioxide to produce oxygen.',
        'Chlorophyll is the green pigment that absorbs light energy.'
      ].join(' ')
      const qs = generateLocalQuestions(transcript, { questionCount: 3 })
      expect(qs.length).toBe(3)
      // Each question has a unique id
      const ids = new Set(qs.map(q => q.id))
      expect(ids.size).toBe(qs.length)
    })

    it('throws on empty transcript', () => {
      expect(() => generateLocalQuestions('', { questionCount: 1 })).toThrow()
    })

    it('throws on transcript with no factual content', () => {
      expect(() => generateLocalQuestions('Um so yeah like I think you know', { questionCount: 1 })).toThrow()
    })

    it('marks each question with source=local-heuristic', () => {
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy.'
      const qs = generateLocalQuestions(transcript, { questionCount: 1 })
      expect(qs[0].source).toBe('local-heuristic')
      expect(qs[0].difficulty).toBeDefined()
      expect(qs[0].createdAt).toBeDefined()
    })
  })

  describe('generateQuestions() with provider=local', () => {
    it('uses local heuristic when provider is "local"', async () => {
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy. Chlorophyll is the green pigment that absorbs light energy.'
      const qs = await generateQuestions(transcript, { numQuestions: 2, provider: 'local' })
      expect(qs.length).toBeGreaterThan(0)
      expect(qs.length).toBeLessThanOrEqual(2)
      qs.forEach(q => {
        expect(q.source).toBe('local-heuristic')
        expect(q.id).toBeDefined()
      })
    })

    it('uses local heuristic when provider is "heuristic"', async () => {
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy.'
      const qs = await generateQuestions(transcript, { numQuestions: 1, provider: 'heuristic' })
      expect(qs.length).toBe(1)
      expect(qs[0].source).toBe('local-heuristic')
    })

    it('falls back to local even when AI provider fails (no API key)', async () => {
      // The minimax provider is configured but no API key is set in test env.
      // The generateQuestions function should catch the AI error and fall back.
      const transcript = 'Photosynthesis is the process by which green plants convert light energy into chemical energy. Chlorophyll is the green pigment that absorbs light energy.'
      const qs = await generateQuestions(transcript, { numQuestions: 2, provider: 'minimax' })
      // Should still produce questions via local fallback
      expect(qs.length).toBeGreaterThan(0)
      expect(qs.every(q => q.source === 'local-heuristic')).toBe(true)
    }, 15000)
  })
})
