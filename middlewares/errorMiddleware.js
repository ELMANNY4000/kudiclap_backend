/**
 * middlewares/errorMiddleware.js
 *
 * Global error handling middleware for the KudiClap Express app.
 *
 * In Express, any middleware with FOUR parameters (err, req, res, next) is
 * treated as an error handler. When any route or middleware calls next(error),
 * or when an unhandled error is thrown inside a route, Express skips all
 * normal middleware and jumps straight to this handler.
 *
 * This centralizes error responses so we don't repeat try/catch res.status(500)
 * blocks in every single controller. Controllers can just throw or call next(err).
 *
 * Registration: this MUST be the last middleware registered in app.js,
 * after all routes — otherwise it won't catch errors from those routes.
 *
 * Usage (in a controller):
 *   try { ... } catch (err) { next(err); }
 *   or simply: throw new Error('Something went wrong');
 */

/**
 * Handles all errors that bubble up through the Express middleware chain.
 *
 * @param {Error}    err  - The error object (thrown or passed via next(err))
 * @param {object}   req  - Express request object
 * @param {object}   res  - Express response object
 * @param {Function} next - Express next function (required as 4th param even if unused)
 */
const errorMiddleware = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Log the full stack trace to the server console for debugging.
  // In production you'd pipe this to a logging service (e.g. Datadog, Sentry).
  console.error('─── Unhandled Error ───────────────────────────────');
  console.error(`[${new Date().toISOString()}] ${err.message}`);
  console.error(err.stack);
  console.error('───────────────────────────────────────────────────');

  // Use the error's status code if it was set deliberately (e.g. 400, 404),
  // otherwise fall back to 500 Internal Server Error.
  const statusCode = err.statusCode || err.status || 500;

  // Send a clean JSON error response to the client.
  // We don't expose the full stack trace to the client for security reasons —
  // only show it in non-production environments for easier debugging.
  res.status(statusCode).json({
    success: false,
    error: err.message || 'An unexpected error occurred. Please try again.',
    // Only include the stack trace when running locally (not in production)
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
};

module.exports = errorMiddleware;
