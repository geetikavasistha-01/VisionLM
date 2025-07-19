import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { notebookId, filePath, sourceType } = await req.json()

    if (!notebookId || !sourceType) {
      return new Response(
        JSON.stringify({ error: 'notebookId and sourceType are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Processing request:', { notebookId, filePath, sourceType });

    // Get environment variables
    const webServiceUrl = Deno.env.get('NOTEBOOK_GENERATION_URL')
    const authHeader = Deno.env.get('NOTEBOOK_GENERATION_AUTH')

    if (!webServiceUrl || !authHeader) {
      console.error('Missing environment variables:', {
        hasUrl: !!webServiceUrl,
        hasAuth: !!authHeader
      })
      
      return new Response(
        JSON.stringify({ error: 'Web service configuration missing' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Update notebook status to 'generating'
    await supabaseClient
      .from('notebooks')
      .update({ generation_status: 'generating' })
      .eq('id', notebookId)

    console.log('Calling external web service...')

    // Prepare payload based on source type
    let payload: any = {
      sourceType: sourceType
    };

    if (sourceType === 'text') {
      // For text sources, get the content from the database
      const { data: source, error: sourceError } = await supabaseClient
        .from('sources')
        .select('content, title')
        .eq('notebook_id', notebookId)
        .eq('type', 'text')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (sourceError || !source?.content) {
        console.error('Failed to get text content:', sourceError);
        
        await supabaseClient
          .from('notebooks')
          .update({ generation_status: 'failed' })
          .eq('id', notebookId)

        return new Response(
          JSON.stringify({ error: 'Failed to get text content for processing' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      payload.content = source.content;
      payload.title = source.title;
    } else if (sourceType === 'website') {
      // For website sources, use the URL
      const { data: source, error: sourceError } = await supabaseClient
        .from('sources')
        .select('url, title')
        .eq('notebook_id', notebookId)
        .eq('type', 'website')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (sourceError || !source?.url) {
        console.error('Failed to get website URL:', sourceError);
        
        await supabaseClient
          .from('notebooks')
          .update({ generation_status: 'failed' })
          .eq('id', notebookId)

        return new Response(
          JSON.stringify({ error: 'Failed to get website URL for processing' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      payload.filePath = source.url;
      payload.title = source.title;
    } else if (filePath) {
      // For file sources (PDF, audio)
      payload.filePath = filePath;
    } else {
      console.error('No valid source data found for generation');
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ error: 'No valid source data found for generation' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Sending payload to web service:', payload);

    // Call external web service
    const response = await fetch(webServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      console.error('Web service error:', response.status, response.statusText)
      const errorText = await response.text();
      console.error('Error response:', errorText);
      
      // Update status to failed
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ error: 'Failed to generate content from web service' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const generatedData = await response.json()
    console.log('Generated data:', generatedData)

    // Parse the response format: object with output property
    let title, description, notebookIcon, backgroundColor, exampleQuestions;
    
    if (generatedData && generatedData.output) {
      const output = generatedData.output;
      title = output.title;
      description = output.summary;
      notebookIcon = output.notebook_icon;
      backgroundColor = output.background_color;
      exampleQuestions = output.example_questions || [];
    } else if (generatedData && generatedData.title) {
      // Handle direct response format
      title = generatedData.title;
      description = generatedData.summary;
      notebookIcon = generatedData.notebook_icon;
      backgroundColor = generatedData.background_color;
      exampleQuestions = generatedData.example_questions || [];
    } else {
      console.error('Unexpected response format:', generatedData)
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ error: 'Invalid response format from web service' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!title) {
      console.error('No title returned from web service')
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ error: 'No title in response from web service' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Update notebook with generated content including icon, color, and example questions
    const { error: notebookError } = await supabaseClient
      .from('notebooks')
      .update({
        title: title,
        description: description || null,
        icon: notebookIcon || '📝',
        color: backgroundColor || 'gray',
        example_questions: exampleQuestions || [],
        generation_status: 'completed'
      })
      .eq('id', notebookId)

    if (notebookError) {
      console.error('Notebook update error:', notebookError)
      return new Response(
        JSON.stringify({ error: 'Failed to update notebook' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Successfully updated notebook with example questions:', exampleQuestions)

    return new Response(
      JSON.stringify({ 
        success: true, 
        title, 
        description,
        icon: notebookIcon,
        color: backgroundColor,
        exampleQuestions,
        message: 'Notebook content generated successfully' 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    
    // Try to update notebook status to failed if we have the notebookId
    try {
      const { notebookId } = await req.json()
      if (notebookId) {
        const supabaseClient = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )
        
        await supabaseClient
          .from('notebooks')
          .update({ generation_status: 'failed' })
          .eq('id', notebookId)
      }
    } catch (e) {
      console.error('Failed to update notebook status to failed:', e)
    }
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})