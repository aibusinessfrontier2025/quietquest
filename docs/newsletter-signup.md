# QuietQuest Newsletter Signup

A modern, responsive newsletter signup page with client-side validation and ready-to-integrate backend support.

## Features

- **Clean, Modern Design**: Beautiful gradient background with smooth animations
- **Fully Responsive**: Works perfectly on desktop, tablet, and mobile devices
- **Form Validation**: Real-time email validation and error handling
- **User-Friendly**: Clear error messages and success feedback
- **Privacy-Focused**: Includes consent checkbox and privacy notice
- **No Dependencies**: Pure HTML, CSS, and JavaScript - no build tools required

## Quick Start

1. Open `newsletter-signup.html` in any web browser
2. The page works standalone without any server setup

## File Structure

```
quietquest/
├── newsletter-signup.html   # Main newsletter signup page
└── README.md               # This file
```

## Backend Integration

The form is ready to connect to your backend API. Follow these steps:

### 1. API Endpoint Setup

In the JavaScript section of `newsletter-signup.html` (around line 285), replace the TODO comment with your actual API call:

```javascript
// Replace this section:
const response = await fetch('/api/newsletter/subscribe', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify(formData)
});

if (!response.ok) {
    throw new Error('Subscription failed');
}
```

### 2. Form Data Structure

The form sends the following JSON data:

```json
{
    "name": "John Doe",
    "email": "john@example.com",
    "consent": true,
    "timestamp": "2026-01-10T12:00:00.000Z"
}
```

### 3. Backend Requirements

Your API endpoint should:
- Accept POST requests
- Expect JSON payload with the structure above
- Return appropriate HTTP status codes:
  - `200` or `201` for successful subscription
  - `400` for validation errors
  - `500` for server errors
- Handle duplicate email addresses gracefully

### 4. Popular Backend Integrations

#### Mailchimp
```javascript
const response = await fetch('https://YOUR_MAILCHIMP_ENDPOINT', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        email_address: formData.email,
        status: 'subscribed',
        merge_fields: {
            FNAME: formData.name.split(' ')[0],
            LNAME: formData.name.split(' ').slice(1).join(' ')
        }
    })
});
```

#### SendGrid
```javascript
const response = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
    method: 'PUT',
    headers: {
        'Authorization': 'Bearer YOUR_API_KEY',
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        contacts: [{
            email: formData.email,
            first_name: formData.name.split(' ')[0],
            last_name: formData.name.split(' ').slice(1).join(' ')
        }]
    })
});
```

#### Custom Node.js Backend
```javascript
// Example Express.js endpoint
app.post('/api/newsletter/subscribe', async (req, res) => {
    const { name, email, consent } = req.body;

    // Validate input
    if (!name || !email || !consent) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Save to database
    try {
        await db.subscribers.insert({ name, email, consent, createdAt: new Date() });
        res.status(201).json({ message: 'Successfully subscribed' });
    } catch (error) {
        res.status(500).json({ error: 'Subscription failed' });
    }
});
```

## Customization

### Colors
The page uses a purple gradient theme. To change colors, modify these CSS variables:

```css
/* Background gradient */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);

/* Button gradient */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);

/* Focus color */
border-color: #667eea;
```

### Text Content
Edit the content directly in the HTML:
- Title: Line 44 (`<h1>Join Our Newsletter</h1>`)
- Description: Line 45 (`<p>Stay updated...</p>`)
- Privacy note: Line 106-108

### Form Fields
To add additional fields (e.g., phone number, company), follow the existing pattern:

```html
<div class="form-group">
    <label for="company">Company</label>
    <input
        type="text"
        id="company"
        name="company"
        placeholder="Enter your company name"
    >
    <div class="error-message" id="companyError">Please enter your company</div>
</div>
```

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Security Considerations

1. **HTTPS**: Always serve this page over HTTPS in production
2. **CORS**: Configure CORS properly on your API endpoint
3. **Rate Limiting**: Implement rate limiting on your backend to prevent abuse
4. **Email Verification**: Send confirmation emails to verify addresses
5. **GDPR Compliance**: Ensure consent checkbox meets legal requirements
6. **Input Sanitization**: Sanitize all inputs on the backend

## Testing

To test the form:
1. Open the page in a browser
2. Try submitting without filling fields (validation should trigger)
3. Enter an invalid email (should show error)
4. Submit without checking consent (should show error)
5. Fill all fields correctly and submit
6. Check browser console for the logged form data

## License

This project is open source and available for use in your projects.

## Support

For issues or questions, please create an issue in the repository.
