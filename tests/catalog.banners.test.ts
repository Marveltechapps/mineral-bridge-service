import { describe, expect, it } from 'vitest';
import { homeBannerByName, homePageBanners, parseBannerCsv } from '../src/modules/catalog/banners.js';

const CSV = `App,
Banner Name,Banner URL
Artisanal Mining 1,https://cdn.example/app/mining.png?w=600&q=60
Home Page 1,https://cdn.example/app/HomePage%201.png?w=600&q=60
Home Page 2,https://cdn.example/app/HomePage%202.png?w=600&q=60
Splash Screen,not-a-url
`;

describe('master sheet banners', () => {
  it('reads banner rows after the section label and keeps home page images in order', () => {
    const items = parseBannerCsv(CSV);
    expect(items.map((item) => item.name)).toEqual(['Artisanal Mining 1', 'Home Page 1', 'Home Page 2']);
    expect(homePageBanners(items).map((item) => item.url)).toEqual([
      'https://cdn.example/app/HomePage%201.png?w=600&q=60',
      'https://cdn.example/app/HomePage%202.png?w=600&q=60',
    ]);
    expect(homeBannerByName(items, 'home page 2')?.name).toBe('Home Page 2');
    expect(homeBannerByName(items, 'Artisanal Mining 1')).toBeUndefined();
  });
});
