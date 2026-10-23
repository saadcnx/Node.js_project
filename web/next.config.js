const target = process.env.API_INTERNAL_URL ?? 'http://server:4000';

module.exports = {
  compress: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};