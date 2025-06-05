const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const axios = require('axios');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// B2 Configuration
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || 'nuculture-media';
const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://api.backblazeb2.com';

// Email Configuration
const BOSS_EMAIL = process.env.BOSS_EMAIL || 'boss@nuculture.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'workflow@nuculture.com';
const APP_URL = process.env.APP_URL || 'https://your-app.azurestaticapps.net';

// B2 auth cache
let b2Auth = null;
let b2AuthExpiry = 0;

module.exports = async function (context, req) {
    const action = context.bindingData.action || '';
    
    context.log('Upload API called with action:', action);
    
    try {
        switch (action) {
            case 'prepare':
                await handlePrepareUpload(context, req);
                break;
            case 'complete':
                await handleUploadComplete(context, req);
                break;
            default:
                context.res = {
                    status: 400,
                    body: { error: 'Invalid action' }
                };
        }
    } catch (error) {
        context.log.error('API Error:', error);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};

async function handlePrepareUpload(context, req) {
    const { fileName, fileSize, metadata } = req.body;
    
    context.log('Preparing upload for:', fileName);
    
    // Authorize B2
    const auth = await authorizeB2();
    
    // Generate file path
    const timestamp = Date.now();
    const fileId = `${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
    
    let filePath;
    if (metadata.uploadType === 'raw') {
        const editorEmail = metadata.editor.split('@')[0];
        filePath = `raw_uploads/${editorEmail}/${timestamp}_${metadata.clientName.replace(/\s+/g, '_')}/${fileName}`;
    } else {
        filePath = `edited_uploads/review/${timestamp}_${metadata.projectName.replace(/\s+/g, '_')}/${fileName}`;
    }
    
    // Get upload URL from B2
    const uploadUrlResponse = await axios.post(
        `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
        { bucketId: B2_BUCKET_ID },
        {
            headers: {
                'Authorization': auth.authorizationToken,
                'Content-Type': 'application/json'
            }
        }
    );
    
    const uploadData = uploadUrlResponse.data;
    
    // Create the full upload URL with auth token
    const uploadUrl = uploadData.uploadUrl;
    
    context.res = {
        status: 200,
        body: {
            uploadUrl: uploadUrl,
            authToken: uploadData.authorizationToken,
            fileId: fileId,
            filePath: filePath
        }
    };
}

async function handleUploadComplete(context, req) {
    const { metadata, files } = req.body;
    
    context.log('Upload complete, sending notifications');
    
    if (metadata.uploadType === 'raw') {
        await sendEditorEmail(metadata, files);
    } else {
        await sendReviewEmail(metadata, files);
    }
    
    context.res = {
        status: 200,
        body: { success: true, message: 'Notifications sent' }
    };
}

async function authorizeB2() {
    // Check cache
    if (b2Auth && Date.now() < b2AuthExpiry) {
        return b2Auth;
    }
    
    // Authorize
    const authString = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
    
    const response = await axios.get(`${B2_ENDPOINT}/b2api/v2/b2_authorize_account`, {
        headers: {
            'Authorization': `Basic ${authString}`
        }
    });
    
    b2Auth = response.data;
    b2AuthExpiry = Date.now() + (23 * 60 * 60 * 1000); // 23 hours
    
    return b2Auth;
}

async function sendEditorEmail(metadata, files) {
    const editorEmail = metadata.editor;
    const editorName = editorEmail.split('@')[0];
    
    // Generate download links
    const downloadLinks = files.map(file => ({
        name: file.fileName,
        url: `https://f003.backblazeb2.com/file/${B2_BUCKET_NAME}/${file.filePath}`,
        size: formatFileSize(file.size)
    }));
    
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #007bff; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background: #f5f5f5; }
        .section { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .button { display: inline-block; padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        ul { list-style: none; padding: 0; }
        li { padding: 5px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>New Footage Assignment</h2>
        </div>
        <div class="content">
            <div class="section">
                <h3>Hi ${editorName},</h3>
                <p>You have new footage to edit from ${metadata.clientName}.</p>
                
                <h4>Project Details:</h4>
                <ul>
                    <li><strong>Client:</strong> ${metadata.clientName}</li>
                    <li><strong>Shoot Date:</strong> ${metadata.shootDate}</li>
                    <li><strong>Footage Type:</strong> ${metadata.footageType}</li>
                    ${metadata.musicType ? `<li><strong>Music Type:</strong> ${metadata.musicType}</li>` : ''}
                </ul>
                
                <h4>Instructions:</h4>
                <div style="background: #f0f0f0; padding: 15px; border-radius: 5px;">
                    ${metadata.instructions.replace(/\n/g, '<br>')}
                </div>
                
                <h4>Download Files:</h4>
                <ul>
                    ${downloadLinks.map(link => 
                        `<li>📎 <a href="${link.url}">${link.name}</a> (${link.size})</li>`
                    ).join('')}
                </ul>
                
                <a href="${APP_URL}" class="button">Upload Edited Version</a>
                
                <p style="margin-top: 20px; font-size: 12px; color: #666;">
                    Files will be available for download for 7 days. Please download them as soon as possible.
                </p>
            </div>
        </div>
    </div>
</body>
</html>
    `;
    
    const msg = {
        to: editorEmail,
        from: FROM_EMAIL,
        subject: `New Footage: ${metadata.clientName} - ${metadata.footageType}`,
        html: emailHtml
    };
    
    await sgMail.send(msg);
}

async function sendReviewEmail(metadata, files) {
    // Generate download links
    const downloadLinks = files.map(file => ({
        name: file.fileName,
        url: `https://f003.backblazeb2.com/file/${B2_BUCKET_NAME}/${file.filePath}`,
        size: formatFileSize(file.size)
    }));
    
    // Create a unique review ID
    const reviewId = crypto.randomBytes(16).toString('hex');
    
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #6c757d; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background: #f5f5f5; }
        .section { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .buttons { text-align: center; margin-top: 30px; }
        .button { display: inline-block; padding: 12px 30px; margin: 0 10px; text-decoration: none; border-radius: 5px; color: white; font-weight: bold; }
        .approve { background: #28a745; }
        .revise { background: #dc3545; }
        ul { list-style: none; padding: 0; }
        li { padding: 5px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>Video Review Required</h2>
        </div>
        <div class="content">
            <div class="section">
                <h3>New Video for Review</h3>
                
                <h4>Project Details:</h4>
                <ul>
                    <li><strong>Project:</strong> ${metadata.projectName}</li>
                    <li><strong>Client:</strong> ${metadata.clientName}</li>
                    <li><strong>Editor:</strong> ${metadata.editorName}</li>
                    <li><strong>Submitted:</strong> ${new Date().toLocaleString()}</li>
                </ul>
                
                ${metadata.description ? `
                <h4>Editor Notes:</h4>
                <div style="background: #f0f0f0; padding: 15px; border-radius: 5px;">
                    ${metadata.description.replace(/\n/g, '<br>')}
                </div>
                ` : ''}
                
                <h4>Review Files:</h4>
                <ul>
                    ${downloadLinks.map(link => 
                        `<li>🎬 <a href="${link.url}">${link.name}</a> (${link.size})</li>`
                    ).join('')}
                </ul>
                
                <div class="buttons">
                    <a href="${APP_URL}/api/review?action=approve&id=${reviewId}&project=${encodeURIComponent(metadata.projectName)}" class="button approve">
                        ✅ Approve
                    </a>
                    <a href="${APP_URL}/api/review?action=revise&id=${reviewId}&project=${encodeURIComponent(metadata.projectName)}" class="button revise">
                        ✏️ Request Revisions
                    </a>
                </div>
                
                <p style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
                    Click one of the buttons above to approve or request revisions.
                </p>
            </div>
        </div>
    </div>
</body>
</html>
    `;
    
    const msg = {
        to: BOSS_EMAIL,
        from: FROM_EMAIL,
        subject: `Review Required: ${metadata.projectName}`,
        html: emailHtml
    };
    
    await sgMail.send(msg);
    
    // Store review data for later use
    // In production, use a database. For MVP, we'll use environment state
    global.reviewData = global.reviewData || {};
    global.reviewData[reviewId] = {
        metadata,
        files,
        timestamp: Date.now()
    };
}

function formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (!bytes) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}