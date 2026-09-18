import { describe, expect, it } from 'vitest';
import {
  dedupeByPerson,
  normalizeGithubLogin,
  normalizeName,
  parseSection,
  parseTeam,
  sortByTimestamp,
  type RawRow,
} from '../src/roster/normalize.js';

describe('normalizeGithubLogin', () => {
  // Six students in the real 2026-1 export pasted a profile URL. The old tool
  // sent these verbatim and got a 404, which aborted the entire run.
  it.each([
    ['https://github.com/jensen-facts', 'jensen-facts'],
    ['https://github.com/pecerax', 'pecerax'],
    ['https://github.com/dantekliwadenko', 'dantekliwadenko'],
    ['https://github.com/ManiaGI', 'ManiaGI'],
    ['https://github.com/bytw1', 'bytw1'],
    ['https://github.com/Tomas-Saavedra-Leon', 'Tomas-Saavedra-Leon'],
    ['http://github.com/foo/', 'foo'],
    ['github.com/bar', 'bar'],
    ['  @baz  ', 'baz'],
    ['xXTheNyanLord777Xx', 'xXTheNyanLord777Xx'],
    ['amaro-carvajal', 'amaro-carvajal'],
  ])('recovers a bare login from %s', (input, expected) => {
    expect(normalizeGithubLogin(input).login).toBe(expected);
  });

  it('treats a blank entry as "no account yet", not an error', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const result = normalizeGithubLogin(blank);
      expect(result.login).toBeNull();
      expect(result.issue).toBeNull();
    }
  });

  it('reports a malformed username instead of passing it to the API', () => {
    const result = normalizeGithubLogin('not a username!');
    expect(result.login).toBeNull();
    expect(result.issue).toContain('not a valid GitHub username');
  });

  it('rejects logins that break GitHub syntax rules', () => {
    expect(normalizeGithubLogin('-leading').login).toBeNull();
    expect(normalizeGithubLogin('trailing-').login).toBeNull();
    expect(normalizeGithubLogin('double--hyphen').login).toBeNull();
    expect(normalizeGithubLogin('a'.repeat(40)).login).toBeNull();
    expect(normalizeGithubLogin('a'.repeat(39)).login).toBe('a'.repeat(39));
  });
});

describe('parseSection / parseTeam', () => {
  it('strips the professor name the form embeds in the section', () => {
    expect(parseSection('1 - Gonzalo')).toBe(1);
    expect(parseSection('2 - Jocelyn')).toBe(2);
    expect(parseSection('2- Jocelyn')).toBe(2);
    expect(parseSection(2)).toBe(2);
    expect(parseSection('')).toBeNull();
  });

  it('parses team numbers', () => {
    expect(parseTeam('11')).toBe(11);
    expect(parseTeam(22)).toBe(22);
    expect(parseTeam(null)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('ignores accents and case so the same person matches across rows', () => {
    expect(normalizeName('Benjamín Francisco Brito Espinoza')).toBe(
      normalizeName('BENJAMIN FRANCISCO BRITO ESPINOZA'),
    );
    expect(normalizeName('  María  Elena   Moya ')).toBe('maria elena moya');
  });
});

describe('dedupeByPerson', () => {
  const row = (over: Partial<RawRow>): RawRow => ({
    fullName: 'Someone',
    email: null,
    githubLogin: null,
    section: '1 - Gonzalo',
    team: '1',
    ...over,
  });

  it('keeps the last response when a student submits twice', () => {
    // Vicente Ferrada submitted on 3/10 and again on 3/17.
    const rows = sortByTimestamp([
      row({ fullName: 'Vicente Ferrada', email: 'ferrada.vicente09@gmail.com', githubLogin: 'Eris7531', timestamp: '2026-03-10T11:49:16', team: '5' }),
      row({ fullName: 'Vicente Ferrada', email: 'ferrada.vicente09@gmail.com', githubLogin: 'Eris7531', timestamp: '2026-03-17T16:29:12', team: '6' }),
    ]);
    const { rows: deduped } = dedupeByPerson(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.team).toBe('6');
  });

  it('matches the same person across two different email addresses', () => {
    // Magdalena Paredes submitted under a ug.uchile.cl and a gmail address.
    // Keying on email alone would have produced a phantom second student.
    const rows = sortByTimestamp([
      row({ fullName: 'Magdalena Paredes Filsecker', email: 'magdalena.paredes@ug.uchile.cl', githubLogin: 'estevio', timestamp: '2026-03-16T12:57:48', team: '21' }),
      row({ fullName: 'Magdalena Paredes Filsecker', email: 'magdalenaparedesfilsecker@gmail.com', githubLogin: 'estevio', timestamp: '2026-03-20T19:09:30', team: '21' }),
    ]);
    const { rows: deduped, notes } = dedupeByPerson(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.email).toBe('magdalenaparedesfilsecker@gmail.com');
    expect(notes).toHaveLength(1);
  });

  it('collapses a repeat submission recorded minutes apart', () => {
    // Martín Mariano submitted twice on 3/10, three minutes apart.
    const rows = sortByTimestamp([
      row({ fullName: 'Martín Antonio Mariano Sierra', email: 'martin.mariano070@gmail.com', githubLogin: 'mattn0', timestamp: '2026-03-10T16:29:39' }),
      row({ fullName: 'Martín Antonio Mariano Sierra', email: 'martin.mariano070@gmail.com', githubLogin: 'mattn0', timestamp: '2026-03-10T16:32:21' }),
    ]);
    expect(dedupeByPerson(rows).rows).toHaveLength(1);
  });

  it('keeps genuinely different students apart', () => {
    const rows = [
      row({ fullName: 'Tomas Morales', githubLogin: 'TomasMoralesBarr' }),
      row({ fullName: 'Tomas Saavedra Leon', githubLogin: 'Tomas-Saavedra-Leon' }),
    ];
    expect(dedupeByPerson(rows).rows).toHaveLength(2);
  });

  it('does not merge two students who both left GitHub blank', () => {
    const rows = [
      row({ fullName: 'Josefina Amaia Millet Aguirre', team: '1' }),
      row({ fullName: 'Andrés Alonso Faúndez Ortega', team: '2' }),
    ];
    expect(dedupeByPerson(rows).rows).toHaveLength(2);
  });
});
