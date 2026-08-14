export function historicalUnavailableStatus(reason: 'missing' | 'corrupt' | 'io_error'): 404 | 409 | 503 {
  switch (reason) {
    case 'missing': return 404;
    case 'corrupt': return 409;
    case 'io_error': return 503;
  }
}
