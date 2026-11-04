// Metro config — uniwind as the outermost wrapper (its transform pipeline
// must see every file before any other customization runs).
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
    cssEntryFile: './global.css',
});
