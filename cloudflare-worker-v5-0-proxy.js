/**
 * Blog TTS API - Cloudflare Workers v5.0
 * Simple proxy to Render backend
 * 
 * Heavy lifting is done by Render:
 * - Multi-chunk TTS generation
 * - Google Drive caching
 * - Sequential audio assembly
 * 
 * Cloudflare just proxies the request
 */

const RENDER_BACKEND_URL = 'https://lbc-blog-tts-backend.onrender.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204, 
        headers: corsHeaders 
      });
    }

    try {
      // Root endpoint
      if (url.pathname === '/') {
        return jsonResponse({
          service: 'LBC Blog TTS API',
          version: '5.0',
          mode: 'proxy-to-render',
          features: ['multi-chunk', 'google-drive-cache', 'sequential-playback'],
          backend: RENDER_BACKEND_URL
        });
      }

      // Health check
      if (url.pathname === '/api/blog/health') {
        try {
          const response = await fetch(`${RENDER_BACKEND_URL}/health`);
          const data = await response.json();
          return jsonResponse({
            status: 'healthy',
            version: '5.0',
            backend: data
          });
        } catch (error) {
          return jsonResponse({
            status: 'unhealthy',
            error: 'Backend unavailable',
            message: error.message
          }, 503);
        }
      }

      // Proxy all other requests to Render backend
      if (url.pathname === '/api/blog/read-aloud' || 
          url.pathname === '/api/blog/generate-audio') {
        
        let body = null;
        if (request.method === 'POST') {
          body = await request.text();
        }

        const renderUrl = new URL(
          url.pathname.replace('/api/blog/', ''),
          RENDER_BACKEND_URL
        );

        const proxyRequest = new Request(renderUrl, {
          method: request.method,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'LBC-Cloudflare-Proxy/5.0'
          },
          body: body
        });

        const response = await fetch(proxyRequest);
        const responseData = await response.json();

        return new Response(JSON.stringify(responseData), {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      // 404
      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.error('Proxy error:', error.message);
      return jsonResponse({
        success: false,
        error: error.message,
        service: 'Cloudflare proxy error'
      }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}
