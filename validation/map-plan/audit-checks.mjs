// Structural review gates, not certification of a nationwide business directory.
export function directoryChecks(summary) {
  const provinces = summary?.provinces || [];
  const special = summary?.special || [];
  const required = ['156429021', ...Array.from({ length: 10 }, (_, i) => '1564690' + (21 + i))];
  const seeds = ['156440300', '156440100', '156451100'];
  return {
    responseOk: summary?.httpStatus === 200 && Number(summary?.businessStatus) === 200,
    country: summary?.country?.code === '156000000',
    provinces: provinces.length === 34 && new Set(provinces.map(p => p.code)).size === 34
      && provinces.every(p => /^156\d{2}0000$/.test(p.code) && p.destinations > 0),
    sourceConsistent: summary?.sourceNodeCount > 0 && summary.sourceNodeCount
      === Object.values(summary?.sourceLevelCounts || {}).reduce((a, b) => a + b, 0),
    destinationsConsistent: summary?.destinationCount > 0 && summary.destinationCount
      === Object.values(summary?.kinds || {}).reduce((a, b) => a + b, 0),
    noConflicts: Array.isArray(summary?.conflicts) && summary.conflicts.length === 0,
    noRejected: Array.isArray(summary?.rejected) && summary.rejected.length === 0,
    seededMappings: seeds.every(code => {
      const matches = (summary?.seeded || []).filter(s => s.code === code);
      return matches.length === 1 && matches[0].matched === true;
    }),
    restoredCountyUnits: required.every(code => {
      const matches = special.filter(s => s.adcode === code);
      return matches.length === 1 && matches[0].kind === 'direct-admin-unit';
    }),
    specialCategories: summary?.kinds?.municipality === 4 && summary?.kinds?.['special-region'] === 2
      && summary?.kinds?.['taiwan-destination'] > 0,
  };
}
