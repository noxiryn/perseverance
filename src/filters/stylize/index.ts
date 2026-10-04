/**
 * fx-filters module entry (imported by src/features.ts): registers the creative filter library
 * and the Filter menu (Last Filter, Filter Gallery, per-category submenus).
 */
import { filters } from '../../registry';
import { fxFilterDefs } from './defs';
import { installFilterMenu } from '../ui/menu';

filters.registerMany(fxFilterDefs);
installFilterMenu();

export { fxFilterDefs };
