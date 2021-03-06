
var path = require('path');

module.exports = {
  id: 'client',
  entry: './index.js',
  target: 'web',
  output: {
    filename: '[name].js',
    path: path.join(__dirname, 'dist'),
    chunkFilename: '[id].[chunkhash].js'
  },
  module: {
    loaders: [{
      test: /\.(gif|jpe?g|png|svg|tiff)(\?.*)?$/,
      loader: path.join(__dirname, '..'),
      query: {
        name: '[name].[hash:8].[ext]',
        presets: {
          thumbnail: {
            format: [ 'webp', 'png', 'jpeg' ],
            density: [ 1, 2, 3 ],
            width: 200,
            height: 200,
            quality: 60,
          },
          prefetch: {
            format: 'jpeg',
            mode: 'cover',
            blur: 100,
            quality: 30,
            inline: true,
            width: 50,
            height: 50,
          }
        }
      }
    }]
  }
};
