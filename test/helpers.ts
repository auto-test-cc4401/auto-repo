import { courseConfigSchema, type CourseConfig } from '../src/core/config.js';

export function testConfig(overrides: Record<string, unknown> = {}): CourseConfig {
  return courseConfigSchema.parse({
    org: 'DCC-CC4401',
    course: 'CC4401',
    year: '2026',
    semester: '2',
    ...overrides,
  });
}
