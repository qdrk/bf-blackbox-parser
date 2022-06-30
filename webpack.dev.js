const merge = require('webpack-merge');
const common = require('./webpack.config.js');

module.exports = merge.merge(common, {
  mode: 'development',

  optimization: {
    minimize: false,
  }
});
