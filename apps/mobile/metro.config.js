// Metro config — uniwind outermost (its transform must see every file),
// reanimated wrapper inside (worklets plugin chain). heroui-native rides
// on top of this same stack (it IS uniwind-based).
const { getDefaultConfig } = require('expo/metro-config');
const { wrapWithReanimatedMetroConfig } = require('react-native-reanimated/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(wrapWithReanimatedMetroConfig(config), {
    cssEntryFile: './global.css',
    dtsFile: './src/uniwind.d.ts',
});
