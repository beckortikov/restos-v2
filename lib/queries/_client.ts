// Shared API client re-exports. All domain modules under lib/queries/ import
// { api, unwrap, V4Error } from './_client' instead of '../api' so the API
// dependency is funneled through a single seam.
export { api, unwrap, unwrapOr404, unwrapRaw, V4Error } from '../api'
