get: () => S.underFar, set: (v) => { S.underFar = v ? 1 : 0; } },

      { key: 'buriedsky', label: 'skylight that still counts as open sky', min: 0, max: 15, step: 1,
        fmt: (v) => (v | 0),
        hint: 'A face under the surface is only dropped if the air in front of it gets no more than 
this much skylight. Modded and Starlight light fields are not tidy: a sealed cavern reads 
skylight 1-2 in places, and at 0 that leaves floating scraps on cave walls. At 15 nothing is 
dropped for being underground. URL: ?buriedsky' ,
        get: () => S.buriedSky,
        set: (v) => { S.buriedSky = Math.max(0, Math.min(15, v | 0)); applySettings('light'); } },