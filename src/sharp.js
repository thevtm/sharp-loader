import sharp from 'sharp';
import loaderUtils from 'loader-utils';
import product from 'cartesian-product';
import mime from 'mime';

class Serializable {
  constructor(render) {
    this.render = render;
  }
}

const UNICODE_CHARS = {
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

const safeString = (str) => {
  return str.replace(/[\r\n\t<>\u2028\u2029"/]/, (unsafeChar) => {
    return UNICODE_CHARS[unsafeChar];
  });
};

const serialize = (source) => {
  if (source instanceof Serializable) {
    return source.render();
  } if (source === null) {
    return 'null';
  } else if (Array.isArray(source)) {
    const tmp = source.map((item) => {
      return serialize(item);
    });
    return `[${tmp.join(',')}]`;
  } else if (typeof source === 'object') {
    const tmp = Object.keys(source).map((key) => {
      return `"${safeString(key)}": ${serialize(source[key])}`;
    });
    return `{${tmp.join(',')}}`;
  } else if (typeof source === 'string') {
    return `"${safeString(source)}"`;
  }
  return `${source}`;
};

const normalizeProperty = (key, value) => {
  switch (key) {
  case 'density':
  case 'blur':
  case 'width':
  case 'height':
    return Number(value);
  default:
    return value;
  }
};

const normalizePreset = (options, ...args) => {
  const normalize = (key, val) => {
    if (typeof val === 'function') {
      return normalize(key, val(...args));
    } else if (Array.isArray(val)) {
      return val.map((v) => normalizeProperty(key, v));
    }
    return [normalizeProperty(key, val)];
  };
  const keys = Object.keys(options);
  const result = {};
  keys.forEach((key) => {
    result[key] = normalize(key, options[key]);
  });
  return result;
};

const multiplex = (options) => {
  const keys = Object.keys(options);
  const values = product(keys.map((key) => {
    return options[key];
  }));
  return values.map((entries) => {
    const result = {};
    keys.forEach((key, i) => {
      result[key] = entries[i];
    });
    return result;
  });
};

/**
 * Perform a sequence of transformations on an image.
 * @param {Object} image Initial sharp object.
 * @param {Object} options Transformations to apply.
 * @returns {Object} Resulting sharp object.
 */
const transform = (image, options = {}) => {
  return [
    'blur',
    'resize',
    'max',
    'min',
    'crop',
    'toFormat',
  ].reduce(function(image, key) {
    if (key in options) {
      let value = options[key];
      value = Array.isArray(value) ? value : [value];
      return image[key].apply(image, value);
    }
    return image;
  }, image.clone());
};

/**
 * Generate the appropriate extension for a `sharp` format.
 * @param  {String} type `sharp` type.
 * @returns {String} Extension.
 */
const extension = (type) => {
  return {
    webp: '.webp',
    jpeg: '.jpg',
    png: '.png',
  }[type];
};

/**
 * Take some configuration options and transform them into a format that
 * `transform` is capable of using.
 * @param {Object} options Generic configuration options.
 * @param {Object} meta Image metadata about original image from sharp.
 * @param {Object} base Original, non-multiplexed data.
 * @returns {Object} `transform` compatible options.
 */
const normalizeSharpOptions = (options, meta, base) => {
  const result = { };
  if (options.format) {
    result.toFormat = options.format;
  }

  // Sizing
  if (options.width || options.height) {
    result.resize = [options.width, options.height];
  }

  // Multiplicative density
  if (options.density) {
    const intrinsic = Math.max(...base.density);
    const density = options.density;
    result.resize = [
      meta.width * (density / intrinsic),
      meta.height * (density / intrinsic),
    ];
  }

  // Mimic background-size
  switch (options.mode) {
  case 'cover':
    result.min = true;
    break;
  case 'contain':
    result.max = true;
    break;
  default:
    result.crop = sharp.gravity.center;
    break;
  }

  result.inline = !!options.inline;
  return result;
};

const emit = (input, options, loader) => {
  const name = (image, info, params) => {
    const template = (params.name || options.name || '[name].[ext]').replace(
      /\[([^\]]+)\]/g,
      (str, name) => {
        if (/^(name|hash)$/.test(name)) {
          return str;
        }
        if (params[name]) {
          return params[name];
        }
        if (info[name]) {
          return info[name];
        }
        return str;
      }
    );
    return loaderUtils.interpolateName({
      resourcePath: loader.resourcePath
        .replace(/\.[^.]+$/, extension(info.format)),
      options: loader.options,
    }, template, {
      context: options.context || loader.options.context,
      content: input,
    });
  };

  const data = (image, info, options, preset) => {
    const n = name(image, info, options, preset);
    const type = mime.getType(n);
    const result = {
      ...options,
      ...info,
      type,
      preset,
      name: n,
      url: options.inline ? [
        'data:',
        type,
        ';base64,',
        image.toString('base64'),
      ].join('') : new Serializable(() => {
        return `__webpack_public_path__ + ${serialize(n)}`;
      }),
    };
    if (!options.inline) {
      loader.emitFile(n, image);
    }
    return result;
  };

  return (preset, presetOptions, image, base) => {
    const transformedImage = transform(
      image,
      normalizeSharpOptions(presetOptions, image._meta, base)
    );

    // We have to use the callback form in order to get access to the info
    // object unfortunately.
    return new Promise(function(resolve, reject) {
      transformedImage.toBuffer(function(err, buffer, info) {
        if (err) {
          reject(err);
        } else {
          resolve(data(buffer, info, presetOptions, preset));
        }
      });
    });
  };
};

const handle = (image, preset, name, presets, emit) => {
  const base = normalizePreset({
    ...presets[name],
    preset,
  }, image._meta);
  if (name && !presets[name]) {
    return [Promise.reject(`No such preset: ${preset}`)];
  }
  const values = multiplex(base, image._meta);
  return values.map((options) => {
    return emit(name, options, image, base);
  });
};

const lolol = (image, extra, presets, globals, emit) => {
  if (Array.isArray(presets)) {
    return Promise.all(presets.reduce((results, name) => {
      return [
        ...results,
        ...handle(image, extra, name, globals, emit),
      ];
    }, []));
  } else if (typeof presets === 'object') {
    return Promise.all(Object.keys(presets).reduce((results, name) => {
      const preset = presets[name];
      return [
        ...results,
        ...handle(image, {...preset, ...extra}, name, globals, emit),
      ];
    }, []));
  } else if (typeof presets === 'string') {
    return Promise.all(handle(image, extra, presets, globals, emit));
  }
  throw new TypeError();
};

/* eslint metalab/import/no-commonjs: 0 */
/* global module */
module.exports = function(input) {
  // This means that, for a given query string, the loader will only be
  // run once. No point in barfing out the same image over and over.
  this.cacheable();

  const globalQuery = loaderUtils.getOptions(this);
  const localQuery = this.resourceQuery ?
    loaderUtils.parseQuery(this.resourceQuery) : {
      presets: Object.keys(globalQuery.presets),
    };
  // console.log('LOCAL?', localQuery);
  // console.log('GLOBAL?', globalQuery);
  const {preset: _1, presets: _2, ...extra} = localQuery;
  let assets;
  const image = sharp(input);
  const callback = this.async();
  const e = emit(input, globalQuery, this);

  // We have three possible choices:
  // - set of presets in `presets`
  // - single preset in `preset`
  // - single value
  image.metadata().then((meta) => {
    image._meta = meta;
    if (localQuery.presets) {
      assets = lolol(image, extra, localQuery.presets, globalQuery.presets, e);
    } else if (localQuery.preset) {
      assets = lolol(image, extra, localQuery.preset, globalQuery.presets, e);
    } else {
      assets = Promise.all(
        handle(image, extra, null, globalQuery.presets, e)
      );
    }
    return assets.then(function(assets) {
      return `module.exports = ${serialize(assets)};`;
    });
  }).then((result) => callback(null, result), callback);
};

// Force buffers since sharp doesn't want strings.
module.exports.raw = true;
