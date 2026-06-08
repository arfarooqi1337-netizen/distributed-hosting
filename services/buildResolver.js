/**
 * Build Resolver Service
 *
 * Inspects uploaded project files to auto-detect:
 * - Application type (static, nodejs, python, php, docker)
 * - Package manager
 * - Install command
 * - Build command
 * - Start command
 * - Output directory
 * - Internal port
 * - Required node capabilities
 */

const logger = require('../config/logger');

/**
 * Analyze uploaded files and detect the application type.
 * @param {Array} files - List of { name, path } from extracted archive
 * @returns {Object} detected config
 */
function detectAppType(files) {
  const names = files.map(f => f.name.toLowerCase());
  const allNames = files.map(f => f.name.toLowerCase());
  const hasFile = (pattern) => allNames.some(n => n === pattern || n.endsWith('/' + pattern));

  // Check for Dockerfile
  if (hasFile('dockerfile')) {
    return {
      type: 'docker',
      confidence: 'high',
      buildCommand: 'docker build',
      internalPort: 8080,
      requiredCapability: 'dockerHostingSupported',
    };
  }

  // Check for Node.js
  if (hasFile('package.json') || hasFile('package-lock.json') || hasFile('yarn.lock')) {
    return detectNodeType(files, allNames);
  }

  // Check for Python
  if (hasFile('requirements.txt') || hasFile('pyproject.toml') || hasFile('pipfile') || hasFile('setup.py')) {
    return detectPythonType(files, allNames);
  }

  // Check for PHP
  if (hasFile('index.php') || hasFile('composer.json') || hasFile('artisan')) {
    return detectPhpType(files, allNames);
  }

  // Check for static site with build config
  if (hasFile('vite.config.js') || hasFile('vite.config.ts') || hasFile('webpack.config.js') || hasFile('.parcelrc')) {
    return {
      type: 'nodejs',
      confidence: 'medium',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      outputDir: 'dist',
      internalPort: 80,
      requiredCapability: 'dockerHostingSupported',
    };
  }

  // Default: static site
  if (hasFile('index.html') || hasFile('index.htm')) {
    return {
      type: 'static',
      confidence: 'high',
      installCommand: '',
      buildCommand: '',
      outputDir: '',
      internalPort: 80,
      requiredCapability: 'staticHostingSupported',
    };
  }

  // If public/ or dist/ exists, it's likely static
  const hasPublicDir = files.some(f => f.name.startsWith('public/') && (f.name.endsWith('.html') || f.name.endsWith('.htm')));
  const hasDistDir = files.some(f => f.name.startsWith('dist/') && (f.name.endsWith('.html') || f.name.endsWith('.htm')));

  if (hasPublicDir) {
    return { type: 'static', confidence: 'medium', installCommand: '', buildCommand: '', outputDir: 'public', internalPort: 80, requiredCapability: 'staticHostingSupported' };
  }
  if (hasDistDir) {
    return { type: 'static', confidence: 'medium', installCommand: '', buildCommand: '', outputDir: 'dist', internalPort: 80, requiredCapability: 'staticHostingSupported' };
  }

  // Unknown — default to static
  return {
    type: 'static',
    confidence: 'low',
    installCommand: '',
    buildCommand: '',
    outputDir: '',
    internalPort: 80,
    requiredCapability: 'staticHostingSupported',
  };
}

/**
 * Detect Node.js application subtype.
 */
function detectNodeType(files, allNames) {
  const hasFile = (pattern) => allNames.some(n => n === pattern || n.endsWith('/' + pattern));

  // Check for Next.js
  if (hasFile('next.config.js') || hasFile('next.config.ts')) {
    return {
      type: 'nodejs',
      subtype: 'nextjs',
      confidence: 'high',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      outputDir: '.next',
      internalPort: 3000,
      requiredCapability: 'dockerHostingSupported',
    };
  }

  // Check for React/Vite
  if (hasFile('vite.config.js') || hasFile('vite.config.ts')) {
    return {
      type: 'static',
      subtype: 'react-vite',
      confidence: 'high',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      outputDir: 'dist',
      internalPort: 80,
      requiredCapability: 'staticHostingSupported',
    };
  }

  // Check for Express/Fastify/ generic Node.js
  if (hasFile('server.js') || hasFile('app.js') || hasFile('index.js')) {
    return {
      type: 'nodejs',
      confidence: 'high',
      installCommand: 'npm install',
      buildCommand: '',
      startCommand: hasFile('server.js') ? 'node server.js' : hasFile('app.js') ? 'node app.js' : 'node index.js',
      outputDir: '',
      internalPort: 3000,
      requiredCapability: 'dockerHostingSupported',
    };
  }

  // Generic package.json — check scripts
  return {
    type: 'nodejs',
    confidence: 'medium',
    installCommand: 'npm install',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    outputDir: '',
    internalPort: 3000,
    requiredCapability: 'dockerHostingSupported',
  };
}

/**
 * Detect Python application subtype.
 */
function detectPythonType(files, allNames) {
  const hasFile = (pattern) => allNames.some(n => n === pattern || n.endsWith('/' + pattern));

  // Check for Django
  if (hasFile('manage.py') || hasFile('wsgi.py')) {
    const projectName = files.find(f => f.name.endsWith('/wsgi.py'))?.name?.split('/')[0] || '';
    return {
      type: 'python',
      subtype: 'django',
      confidence: 'high',
      installCommand: 'pip install -r requirements.txt',
      buildCommand: '',
      startCommand: projectName ? `gunicorn ${projectName}.wsgi:application --bind 0.0.0.0:8000` : 'python manage.py runserver 0.0.0.0:8000',
      outputDir: '',
      internalPort: 8000,
      requiredCapability: 'pythonHostingSupported',
    };
  }

  // Check for FastAPI
  if (hasFile('main.py')) {
    return {
      type: 'python',
      subtype: 'fastapi',
      confidence: 'medium',
      installCommand: 'pip install -r requirements.txt',
      buildCommand: '',
      startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000',
      outputDir: '',
      internalPort: 8000,
      requiredCapability: 'pythonHostingSupported',
    };
  }

  // Check for Flask
  if (hasFile('app.py')) {
    return {
      type: 'python',
      subtype: 'flask',
      confidence: 'high',
      installCommand: 'pip install -r requirements.txt',
      buildCommand: '',
      startCommand: 'gunicorn app:app --bind 0.0.0.0:8000',
      outputDir: '',
      internalPort: 8000,
      requiredCapability: 'pythonHostingSupported',
    };
  }

  // Generic Python
  return {
    type: 'python',
    confidence: 'low',
    installCommand: 'pip install -r requirements.txt',
    buildCommand: '',
    startCommand: 'python app.py',
    outputDir: '',
    internalPort: 8000,
    requiredCapability: 'pythonHostingSupported',
  };
}

/**
 * Detect PHP application subtype.
 */
function detectPhpType(files, allNames) {
  const hasFile = (pattern) => allNames.some(n => n === pattern || n.endsWith('/' + pattern));

  if (hasFile('artisan')) {
    return {
      type: 'php',
      subtype: 'laravel',
      confidence: 'high',
      installCommand: 'composer install',
      buildCommand: '',
      startCommand: 'php artisan serve --host=0.0.0.0 --port=8080',
      outputDir: 'public',
      internalPort: 8080,
      requiredCapability: 'dockerHostingSupported',
    };
  }

  return {
    type: 'php',
    confidence: 'medium',
    installCommand: 'composer install',
    buildCommand: '',
    startCommand: '',
    outputDir: '',
    internalPort: 8080,
    requiredCapability: 'dockerHostingSupported',
  };
}

/**
 * Resolve build config from a list of extracted files.
 * @param {Array} fileEntries - Array of { name, type } from extracted directory
 * @returns {Object} Full build config
 */
function resolveBuildConfig(fileEntries) {
  const files = fileEntries.filter(f => f.type === 'file');
  const result = detectAppType(files);

  return {
    type: result.type,
    subtype: result.subtype || '',
    confidence: result.confidence,
    installCommand: result.installCommand || '',
    buildCommand: result.buildCommand || '',
    startCommand: result.startCommand || '',
    outputDir: result.outputDir || '',
    internalPort: result.internalPort || 8080,
    requiredCapability: result.requiredCapability || 'staticHostingSupported',
  };
}

module.exports = {
  detectAppType,
  resolveBuildConfig,
};
