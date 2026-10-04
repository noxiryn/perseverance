/** Every creative filter definition of the fx-filters module, grouped by category. */
import type { FilterDef } from '../../../registry';
import { blurFilters } from './blur';
import { sharpenFilters } from './sharpen';
import { noiseFilters } from './noise';
import { comicFilters } from './comic';
import { stylizeFilters } from './stylize';
import { distortFilters } from './distort';
import { lightFilters } from './light';
import { retroFilters } from './retro';
import { artisticFilters } from './artistic';

export const fxFilterDefs: FilterDef[] = [
  ...stylizeFilters,
  ...comicFilters,
  ...artisticFilters,
  ...blurFilters,
  ...sharpenFilters,
  ...distortFilters,
  ...noiseFilters,
  ...lightFilters,
  ...retroFilters,
];
