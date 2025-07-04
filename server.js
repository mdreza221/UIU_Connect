// server.js

const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const cheerio = require('cheerio');
const { Readable } = require('stream');
const { google } = require('googleapis');

dotenv.config();

const app = express();
const PORT = 3000;

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

const SYSTEM_ANNOUNCER_USER_ID = process.env.SYSTEM_ANNOUNCER_USER_ID;
if (!SYSTEM_ANNOUNCER_USER_ID) {
    console.warn("WARNING: SYSTEM_ANNOUNCER_USER_ID is not configured in .env. Automated announcements will fail.");
} else {
    console.log(`System Announcer User ID: ${SYSTEM_ANNOUNCER_USER_ID}`);
}

// Middleware
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));
app.use(express.static(path.join(__dirname, 'public')));

// Custom Middleware Functions
function authMiddleware(req, res, next) {
    if (!req.session.userId) {
        if (req.xhr || req.headers.accept.indexOf('json') > -1) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        return res.redirect('/');
    }
    next();
}

async function adminMiddleware(req, res, next) {
    if (!req.session.userId || !req.session.roles) {
        const errorMessage = 'Authentication required. Roles not loaded.';
        return req.xhr || req.headers.accept.indexOf('json') > -1
            ? res.status(401).json({ error: errorMessage })
            : res.status(403).send('Access denied. Authentication required.');
    }
    if (!req.session.roles.includes('Admin')) {
        const errorMessage = 'Access denied. Admins only.';
        return req.xhr || req.headers.accept.indexOf('json') > -1
            ? res.status(403).json({ error: errorMessage })
            : res.status(403).send(errorMessage);
    }
    next();
}

// Middleware to check for Faculty or Admin role
function facultyAndAdminMiddleware(req, res, next) {
    if (!req.session.userId || !req.session.roles) {
        return res.status(401).send('Authentication required.');
    }
    // Check if the user has either 'Admin' or 'Faculty' role
    if (!req.session.roles.includes('Admin') && !req.session.roles.includes('Faculty')) {
        return res.status(403).send('Access denied. Faculty or Admin access required.');
    }
    next();
}

// Helper Function to Create Notification
async function createNotification(userId, type, entityId, entityType, senderId) {
    try {
        await pool.query(
            'INSERT INTO notifications (user_id, type, entity_id, entity_type, sender_id) VALUES (?, ?, ?, ?, ?)',
            [userId, type, entityId, entityType, senderId]
        );
        console.log(`Notification created for user ${userId}: type=${type}, entity_id=${entityId}`);
    } catch (error) {
        console.error('Error creating notification:', error);
    }
}

// Authentication Routes
app.post('/signup', async (req, res) => {
    const { name, email, username, password } = req.body;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existing.length > 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'Username or Email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const [userResult] = await connection.query('INSERT INTO users (name, email, username, password_hash, reputation_points) VALUES (?, ?, ?, ?, ?)',
            [name, email, username, hashedPassword, 0]);
        const newUserId = userResult.insertId;

        const [defaultRole] = await connection.query('SELECT id FROM roles WHERE name = ?', ['Student']);
        if (defaultRole.length === 0) {
            await connection.rollback();
            return res.status(500).json({ error: 'Default role "Student" not found. Please ensure roles table is populated.' });
        }
        await connection.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [newUserId, defaultRole[0].id]);

        await connection.commit();
        res.json({ message: 'Signup successful' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Server error during signup' });
    } finally {
        if (connection) connection.release();
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT id, username, name, password_hash FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(400).json({ error: 'Invalid username or password' });

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(400).json({ error: 'Invalid username or password' });

        const [userRoles] = await pool.query(`
            SELECT r.name FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ?
        `, [user.id]);

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.name = user.name;
        req.session.roles = userRoles.map(role => role.name);

        res.json({ message: 'Login successful', user: { username: user.username, roles: req.session.roles } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Page Routes (serving HTML files)
app.get('/', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/profile', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/admin', authMiddleware, adminMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/announcements', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'announcements.html')));
app.get('/settings', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/faq', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'faq.html')));
app.get('/irc', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'irc.html')));
app.get('/inbox', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'inbox.html')));
app.get('/top-contributors', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'top-contributors.html')));
app.get('/events', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'events.html')));
app.get('/career', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'career.html')));
app.get('/alumni', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'alumni.html')));
app.get('/support', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));
// Faculty Panel as a separate feature
app.get('/faculty-panel', authMiddleware, facultyAndAdminMiddleware, (req, res) => {
    return res.sendFile(path.join(__dirname, 'public', 'faculty-panel.html'));
});
// My Activities for all users
app.get('/activities', authMiddleware, (req, res) => {
    return res.sendFile(path.join(__dirname, 'public', 'activities.html'));
});


// Forum Page Routes
app.get('/forum', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'forum.html'));
});
app.get('/forum/sections/:sectionId', authMiddleware, async (req, res) => {
    const sectionId = req.params.sectionId;
    try {
        const [sectionCheck] = await pool.query('SELECT id FROM forum_sections WHERE id = ?', [sectionId]);
        if (sectionCheck.length === 0) {
            return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        }
        res.sendFile(path.join(__dirname, 'public', 'forum.html'));
    } catch (err) {
        console.error('Error serving section page:', err);
        res.status(500).send('Server error when accessing section page.');
    }
});
app.get('/forum/topics/:topicId', authMiddleware, async (req, res) => {
    const topicId = req.params.topicId;
    try {
        const [topicRows] = await pool.query('SELECT id FROM topics WHERE id = ?', [topicId]);
        if (topicRows.length === 0) {
            return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        }
        res.sendFile(path.join(__dirname, 'public', 'topic.html'));
    } catch (err) {
        console.error('Error serving topic page:', err);
        res.status(500).send('Server error when accessing topic page.');
    }
});
app.get('/forum/new-topic', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'new-topic.html'));
});

// API Routes for User Data & Settings
app.get('/user-data', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, name, email, username, reputation_points FROM users WHERE id = ?', [req.session.userId]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = rows[0];

        const [userRoles] = await pool.query(`
            SELECT r.name FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ?
        `, [user.id]);

        req.session.roles = userRoles.map(role => role.name);
        user.roles = req.session.roles;

        res.json({ user: user });
    } catch (err) {
        console.error('Server error fetching user data:', err);
        res.status(500).json({ error: 'Server error fetching user data' });
    }
});

// NEW: API endpoint to get all users (for private post access selection)
app.get('/api/users-list', authMiddleware, async (req, res) => {
    try {
        // Exclude system users or bots if you have them, e.g., SYSTEM_ANNOUNCER_USER_ID
        const [users] = await pool.query('SELECT id, username, name FROM users WHERE id != ? ORDER BY username ASC', [SYSTEM_ANNOUNCER_USER_ID]);
        res.json(users);
    } catch (err) {
        console.error('Error fetching users list:', err);
        res.status(500).json({ error: 'Failed to load user list.' });
    }
});


app.post('/update-settings', authMiddleware, async (req, res) => {
    const { newEmail, newPassword } = req.body;
    const userId = req.session.userId;
    try {
        let query = 'UPDATE users SET ';
        const values = [];
        const updates = [];

        if (newEmail) {
            updates.push('email = ?');
            values.push(newEmail);
        }
        if (newPassword) {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            updates.push('password_hash = ?');
            values.push(hashedPassword);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No settings to update' });
        }

        query += updates.join(', ') + ' WHERE id = ?';
        values.push(userId);

        await pool.query(query, values);
        res.json({ message: 'Settings updated successfully' });
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: 'Error updating settings' });
    }
});

// API Routes for IRC Messages
app.get('/api/messages', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT m.id, m.message, m.created_at, m.user_id, u.username
            FROM messages m
            JOIN users u ON m.user_id = u.id
            ORDER BY m.created_at ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching IRC messages:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

app.post('/api/messages', authMiddleware, async (req, res) => {
    const { message } = req.body;
    try {
        await pool.query('INSERT INTO messages (user_id, message) VALUES (?, ?)', [req.session.userId, message]);
        res.json({ message: 'Message sent' });
    }  catch (err) {
        console.error('Error sending IRC message:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.put('/api/messages/:id', authMiddleware, async (req, res) => {
    const messageId = req.params.id;
    const { message } = req.body;
    const userId = req.session.userId;

    if (!message || message.trim() === '') {
        return res.status(400).json({ error: 'Message content cannot be empty.' });
    }

    try {
        const [msg] = await pool.query('SELECT user_id FROM messages WHERE id = ?', [messageId]);
        if (msg.length === 0) {
            return res.status(404).json({ error: 'Message not found.' });
        }
        if (msg[0].user_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized to edit this message.' });
        }

        await pool.query('UPDATE messages SET message = ?, created_at = NOW() WHERE id = ?', [message, messageId]);
        res.json({ message: 'Message updated successfully.' });
    } catch (err) {
        console.error('Error updating IRC message:', err);
        res.status(500).json({ error: 'Failed to update message.' });
    }
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
    const messageId = req.params.id;
    const userId = req.session.userId;

    try {
        const [msg] = await pool.query('SELECT user_id FROM messages WHERE id = ?', [messageId]);
        if (msg.length === 0) {
            return res.status(404).json({ error: 'Message not found.' });
        }
        if (msg[0].user_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized to delete this message.' });
        }

        const [result] = await pool.query('DELETE FROM messages WHERE id = ?', [messageId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Message not found or already deleted.' });
        }
        res.json({ message: 'Message deleted successfully.' });
    } catch (err) {
        console.error('Error deleting IRC message:', err);
        res.status(500).json({ error: 'Failed to delete message.' });
    }
});

// API Routes for Private Messages
app.post('/api/private-messages', authMiddleware, async (req, res) => {
    const { receiverUsername, subject, content } = req.body;
    try {
        const [receiverRows] = await pool.query('SELECT id FROM users WHERE username = ?', [receiverUsername]);
        if (receiverRows.length === 0) return res.status(404).json({ error: 'Receiver not found' });

        const receiverId = receiverRows[0].id;
        const [messageResult] = await pool.query(
            'INSERT INTO private_messages (sender_id, receiver_id, subject, content) VALUES (?, ?, ?, ?)',
            [req.session.userId, receiverId, subject, content]
        );
        const newMessageId = messageResult.insertId;

        // Create notification for the receiver
        await createNotification(receiverId, 'new_message', newMessageId, 'private_message', req.session.userId);

        res.json({ message: 'Message sent successfully' });
    } catch (err) {
        console.error('Error sending private message:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.get('/api/private-messages', authMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        const [messages] = await pool.query(`
            SELECT pm.id, pm.subject, pm.content, pm.sent_at, pm.read_at,
                   sender.username AS sender_username, receiver.username AS receiver_username,
                   pm.sender_id, pm.receiver_id, pm.sender_deleted, pm.receiver_deleted
            FROM private_messages pm
            JOIN users sender ON pm.sender_id = sender.id
            JOIN users receiver ON pm.receiver_id = receiver.id
            WHERE
                (pm.sender_id = ? AND pm.sender_deleted = FALSE)
                OR
                (pm.receiver_id = ? AND pm.receiver_deleted = FALSE)
            ORDER BY pm.sent_at DESC
        `, [userId, userId]);

        const filteredMessages = messages.filter(msg => {
            return (msg.sender_id === userId && !msg.sender_deleted) ||
                   (msg.receiver_id === userId && !msg.receiver_deleted);
        });

        res.json(filteredMessages);
    } catch (err) {
        console.error('Error fetching private messages:', err);
        res.status(500).json({ error: 'Failed to load messages.' });
    }
});

app.put('/api/private-messages/:id/read', authMiddleware, async (req, res) => {
    const messageId = req.params.id;
    const userId = req.session.userId;

    try {
        const [message] = await pool.query('SELECT receiver_id, read_at FROM private_messages WHERE id = ?', [messageId]);

        if (message.length === 0) {
            return res.status(404).json({ error: 'Message not found.' });
        }
        if (message[0].receiver_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized to mark this message as read.' });
        }
        if (message[0].read_at) {
            return res.status(200).json({ message: 'Message already marked as read.' });
        }

        await pool.query('UPDATE private_messages SET read_at = NOW() WHERE id = ?', [messageId]);
        res.json({ message: 'Message marked as read successfully.' });
    } catch (err) {
        console.error('[PM Read] Error marking message as read:', err);
        res.status(500).json({ error: 'Failed to mark message as read.' });
    }
});

app.delete('/api/private-messages/:id', authMiddleware, async (req, res) => {
    const messageId = req.params.id;
    const userId = req.session.userId;
    const { is_sender } = req.body;

    try {
        const [message] = await pool.query('SELECT sender_id, receiver_id, sender_deleted, receiver_deleted FROM private_messages WHERE id = ?', [messageId]);
        if (message.length === 0) {
            return res.status(404).json({ error: 'Message not found.' });
        }

        const msg = message[0];
        let query;
        let params;

        if (is_sender) {
            if (msg.sender_id !== userId) {
                return res.status(403).json({ error: 'Unauthorized to delete this sent message.' });
            }
            query = 'UPDATE private_messages SET sender_deleted = TRUE WHERE id = ?';
            params = [messageId];
        } else {
            if (msg.receiver_id !== userId) {
                return res.status(403).json({ error: 'Unauthorized to delete this received message.' });
            }
            query = 'UPDATE private_messages SET receiver_deleted = TRUE WHERE id = ?';
            params = [messageId];
        }

        await pool.query(query, params);

        const [updatedMessage] = await pool.query('SELECT sender_deleted, receiver_deleted FROM private_messages WHERE id = ?', [messageId]);

        if (updatedMessage.length > 0 && updatedMessage[0].sender_deleted && updatedMessage[0].receiver_deleted) {
            await pool.query('DELETE FROM private_messages WHERE id = ?', [messageId]);
            return res.json({ message: 'Message permanently deleted.' });
        }

        res.json({ message: 'Message deleted from your view.' });
    } catch (err) {
        console.error('[PM Delete] Error during deletion:', err);
        res.status(500).json({ error: 'Failed to delete message.' });
    }
});

// API Routes for Notifications
app.get('/api/notifications', authMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        const [notifications] = await pool.query(`
            SELECT
                n.id,
                n.type,
                n.entity_id,
                n.entity_type,
                n.is_read,
                n.created_at,
                s.username AS sender_username,
                t.title AS topic_title,
                pm.subject AS message_subject,
                SUBSTRING(p.content, 1, 100) AS post_content_snippet,
                t.id AS topic_id_for_post_reply
            FROM notifications n
            LEFT JOIN users s ON n.sender_id = s.id
            LEFT JOIN topics t ON n.entity_type = 'topic' AND n.entity_id = t.id
            LEFT JOIN private_messages pm ON n.entity_type = 'private_message' AND n.entity_id = pm.id
            LEFT JOIN posts p ON n.entity_type = 'post' AND n.entity_id = p.id
            WHERE n.user_id = ? AND n.is_read = FALSE
            ORDER BY n.created_at DESC
            LIMIT 20
        `, [userId]);

        res.json(notifications);
    } catch (err) {
        console.error('Error fetching notifications:', err);
        res.status(500).json({ error: 'Failed to load notifications.' });
    }
});

app.post('/api/notifications/:id/read', authMiddleware, async (req, res) => {
    const notificationId = req.params.id;
    const userId = req.session.userId;

    try {
        const [result] = await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?', [notificationId, userId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Notification not found or not authorized.' });
        }
        res.json({ message: 'Notification marked as read.' });
    } catch (err) {
        console.error('Error marking notification as read:', err);
        res.status(500).json({ error: 'Failed to mark notification as read.' });
    }
});

app.post('/api/notifications/mark-all-read', authMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [userId]);
        res.json({ message: 'All notifications marked as read.' });
    } catch (err) {
        console.error('Error marking all notifications as read:', err);
        res.status(500).json({ error: 'Failed to mark all notifications as read.' });
    }
});

// API Routes for Support Tickets
// User submits a new support ticket
app.post('/api/support-tickets', authMiddleware, async (req, res) => {
    const { subject, message } = req.body;
    const userId = req.session.userId;

    if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required to create a ticket.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [ticketResult] = await connection.query(
            'INSERT INTO support_tickets (user_id, subject) VALUES (?, ?)',
            [userId, subject]
        );
        const newTicketId = ticketResult.insertId;

        await connection.query(
            'INSERT INTO support_ticket_messages (ticket_id, sender_id, message) VALUES (?, ?, ?)',
            [newTicketId, userId, message]
        );

        // Notify all admins about the new ticket
        const [adminUsers] = await pool.query(`
            SELECT u.id FROM users u
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE r.name = 'Admin'
        `);

        for (const admin of adminUsers) {
            await createNotification(admin.id, 'new_support_ticket', newTicketId, 'support_ticket', userId);
        }

        await connection.commit();
        res.status(201).json({ message: 'Support ticket created successfully!', ticketId: newTicketId });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error creating support ticket:', err);
        res.status(500).json({ error: 'Failed to create support ticket.' });
    } finally {
        if (connection) connection.release();
    }
});

// User views their own support tickets
app.get('/api/support-tickets', authMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        const [tickets] = await pool.query(`
            SELECT
                st.id, st.subject, st.status, st.created_at, st.updated_at,
                u.username AS created_by_username,
                admin_u.username AS admin_assigned_username
            FROM support_tickets st
            JOIN users u ON st.user_id = u.id
            LEFT JOIN users admin_u ON st.admin_assigned_id = admin_u.id
            WHERE st.user_id = ?
            ORDER BY st.updated_at DESC
        `, [userId]);
        res.json(tickets);
    } catch (err) {
        console.error('Error fetching user support tickets:', err);
        res.status(500).json({ error: 'Failed to load support tickets.' });
    }
});

// Admin views all support tickets (with optional status filter)
app.get('/api/admin/support-tickets', authMiddleware, adminMiddleware, async (req, res) => {
    const { status } = req.query; // Optional filter by status
    let query = `
        SELECT
            st.id, st.subject, st.status, st.created_at, st.updated_at,
            u.username AS created_by_username,
            admin_u.username AS admin_assigned_username
        FROM support_tickets st
        JOIN users u ON st.user_id = u.id
        LEFT JOIN users admin_u ON st.admin_assigned_id = admin_u.id
    `;
    const queryParams = [];

    if (status && status !== 'all') {
        query += ` WHERE st.status = ?`;
        queryParams.push(status);
    }
    query += ` ORDER BY st.updated_at DESC`;

    try {
        const [tickets] = await pool.query(query, queryParams);
        res.json(tickets);
    } catch (err) {
        console.error('Error fetching admin support tickets:', err);
        res.status(500).json({ error: 'Failed to load support tickets.' });
    }
});

// Get a specific support ticket's details and messages
app.get('/api/support-tickets/:ticketId', authMiddleware, async (req, res) => {
    const ticketId = req.params.ticketId;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [ticketRows] = await connection.query(`
            SELECT
                st.id, st.user_id, st.subject, st.status, st.created_at, st.updated_at, st.admin_assigned_id,
                u.username AS created_by_username,
                admin_u.username AS admin_assigned_username,
                r.name AS creator_role
            FROM support_tickets st
            JOIN users u ON st.user_id = u.id
            LEFT JOIN users admin_u ON st.admin_assigned_id = admin_u.id
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            WHERE st.id = ?
        `, [ticketId]);

        if (ticketRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ticket not found.' });
        }

        const ticket = ticketRows[0];

        // Access control: Only the ticket creator or an Admin can view the ticket
        if (ticket.user_id !== userId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to view this ticket.' });
        }

        const [messages] = await connection.query(`
            SELECT
                stm.id, stm.sender_id, stm.message, stm.sent_at,
                u.username AS sender_username,
                r.name AS sender_role
            FROM support_ticket_messages stm
            JOIN users u ON stm.sender_id = u.id
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            WHERE stm.ticket_id = ?
            ORDER BY stm.sent_at ASC
        `, [ticketId]);

        // If ticket is 'closed' and current user is not admin, don't change status
        if (ticket.status === 'open' && userRoles.includes('Admin')) {
             await connection.query('UPDATE support_tickets SET status = ? WHERE id = ?', ['in_progress', ticketId]);
        } else if (ticket.status === 'awaiting_user_reply' && ticket.user_id === userId) {
            // No status change needed here, it's just being viewed by the user.
        } else if (ticket.status === 'awaiting_admin_reply' && userRoles.includes('Admin')) {
             await connection.query('UPDATE support_tickets SET status = ? WHERE id = ?', ['in_progress', ticketId]);
        }


        await connection.commit();
        res.json({ ticket, messages });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error fetching support ticket details:', err);
        res.status(500).json({ error: 'Failed to load ticket details.' });
    } finally {
        if (connection) connection.release();
    }
});

// Post a new message/reply to a support ticket
app.post('/api/support-tickets/:ticketId/messages', authMiddleware, async (req, res) => {
    const ticketId = req.params.ticketId;
    const { message } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!message) {
        return res.status(400).json({ error: 'Message content cannot be empty.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [ticketInfo] = await connection.query('SELECT user_id, status, admin_assigned_id FROM support_tickets WHERE id = ?', [ticketId]);
        if (ticketInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ticket not found.' });
        }

        const ticket = ticketInfo[0];

        // Access control: Only the ticket creator or an Admin can reply
        if (ticket.user_id !== userId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to reply to this ticket.' });
        }

        // Prevent replies to closed tickets
        if (ticket.status === 'closed') {
            await connection.rollback();
            return res.status(400).json({ error: 'Cannot reply to a closed ticket.' });
        }

        await connection.query(
            'INSERT INTO support_ticket_messages (ticket_id, sender_id, message) VALUES (?, ?, ?)',
            [ticketId, userId, message]
        );

        let newStatus = ticket.status;
        let recipientId = null; // Who to notify

        if (userRoles.includes('Admin')) {
            // If admin replies, status moves to 'awaiting_user_reply'
            newStatus = 'awaiting_user_reply';
            recipientId = ticket.user_id; // Notify the user
            // Assign admin if not already assigned
            if (ticket.admin_assigned_id === null) {
                await connection.query('UPDATE support_tickets SET admin_assigned_id = ? WHERE id = ?', [userId, ticketId]);
            }
        } else {
            // If user replies, status moves to 'awaiting_admin_reply'
            newStatus = 'awaiting_admin_reply';
            if (ticket.admin_assigned_id) {
                recipientId = ticket.admin_assigned_id; // Notify the assigned admin
            } else {
                // If no admin assigned, notify all admins
                const [adminUsers] = await connection.query(`
                    SELECT u.id FROM users u
                    JOIN user_roles ur ON u.id = ur.user_id
                    JOIN roles r ON ur.role_id = r.id
                    WHERE r.name = 'Admin'
                `);
                for (const admin of adminUsers) {
                    await createNotification(admin.id, 'admin_ticket_reply', ticketId, 'support_ticket', userId);
                }
            }
        }
        await connection.query('UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, ticketId]);

        await connection.commit();

        // Send notification after successful commit
        if (recipientId) {
            const notificationType = userRoles.includes('Admin') ? 'ticket_admin_reply' : 'ticket_user_reply';
            await createNotification(recipientId, notificationType, ticketId, 'support_ticket', userId);
        }


        res.status(201).json({ message: 'Reply posted successfully!' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error posting support ticket message:', err);
        res.status(500).json({ error: 'Failed to post message.' });
    } finally {
        if (connection) connection.release();
    }
});

// Admin updates support ticket status
app.put('/api/support-tickets/:ticketId/status', authMiddleware, adminMiddleware, async (req, res) => {
    const ticketId = req.params.ticketId;
    const { status } = req.body;
    const adminId = req.session.userId;

    const validStatuses = ['open', 'in_progress', 'awaiting_user_reply', 'awaiting_admin_reply', 'closed'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status provided.' });
    }

    try {
        const [ticketInfo] = await pool.query('SELECT user_id, status FROM support_tickets WHERE id = ?', [ticketId]);
        if (ticketInfo.length === 0) {
            return res.status(404).json({ error: 'Ticket not found.' });
        }

        const oldStatus = ticketInfo[0].status;
        const ticketCreatorId = ticketInfo[0].user_id;

        const [result] = await pool.query(
            'UPDATE support_tickets SET status = ?, admin_assigned_id = ?, updated_at = NOW() WHERE id = ?',
            [status, adminId, ticketId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Ticket not found or status not changed.' });
        }

        // Notify the user if the status changed and it's not the user changing it
        if (status !== oldStatus && ticketCreatorId !== adminId) {
            await createNotification(ticketCreatorId, 'ticket_status_update', ticketId, 'support_ticket', adminId);
        }

        res.json({ message: `Ticket status updated to ${status}.` });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error updating ticket status:', err);
        res.status(500).json({ error: 'Failed to update ticket status.' });
    } finally {
        if (connection) connection.release();
    }
});


// API Routes for Admin Panel
app.get('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT id, name, email, username, reputation_points FROM users');

        const userIds = users.map(u => u.id);
        if (userIds.length === 0) return res.json([]);

        const [allUserRoles] = await pool.query(`
            SELECT ur.user_id, r.name FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id IN (?)
        `, [userIds]);

        const usersWithRoles = users.map(user => {
            user.roles = allUserRoles.filter(ur => ur.user_id === user.id).map(ur => ur.name);
            return user;
        });

        res.json(usersWithRoles);
    } catch (err) {
        console.error('Error fetching admin users:', err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

app.get('/api/roles', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const [roles] = await pool.query('SELECT id, name, description FROM roles ORDER BY name ASC');
        res.json(roles);
    } catch (err) {
        console.error('Error fetching roles:', err);
        res.status(500).json({ error: 'Failed to load roles.' });
    }
});

app.post('/admin/users/:id/roles', authMiddleware, adminMiddleware, async (req, res) => {
    const userId = req.params.id;
    const { roleNames } = req.body;

    if (!Array.isArray(roleNames)) {
        return res.status(400).json({ error: 'roleNames must be an array.' });
    }

    if (req.session.userId == userId && !roleNames.includes('Admin')) {
        const [currentUserRoles] = await pool.query(`
            SELECT r.name FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ? AND r.name = 'Admin'
        `, [req.session.userId]);

        if (currentUserRoles.length > 0) {
             return res.status(400).json({ error: 'An admin cannot remove their own Admin role through this panel.' });
        }
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        await connection.query('DELETE FROM user_roles WHERE user_id = ?', [userId]);

        if (roleNames.length > 0) {
            const [rolesToAssign] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [roleNames]);
            // FIX: Corrected variable name from 'allowedRoleNames' to 'roleNames'
            if (rolesToAssign.length !== roleNames.length) {
                await connection.rollback();
                return res.status(400).json({ error: 'One or more provided role names are invalid.' });
            }

            const insertValues = rolesToAssign.map(role => [userId, role.id]);
            await connection.query('INSERT INTO user_roles (user_id, role_id) VALUES ?', [insertValues]);
        }

        await connection.commit();
        res.json({ message: 'User roles updated successfully' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error updating user roles:', err);
        res.status(500).json({ error: 'Failed to update user roles.' });
    } finally {
        if (connection) connection.release();
    }
});

app.delete('/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const userId = req.params.id;
    if (req.session.userId == userId) return res.status(400).json({ error: 'You cannot delete yourself' });
    try {
        const [result] = await pool.query('DELETE FROM users WHERE id = ?', [userId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User deleted successfully.' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Server error deleting user' });
    }
});

// Forum Section Permissions (Admin Panel)
app.get('/api/admin/forum-section-permissions', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const [sections] = await pool.query('SELECT id, name, description FROM forum_sections ORDER BY name ASC');

        const sectionIds = sections.map(s => s.id);
        if (sectionIds.length === 0) return res.json([]);

        const [permissions] = await pool.query(`
            SELECT srp.section_id, r.name AS role_name
            FROM section_role_permissions srp
            JOIN roles r ON srp.role_id = r.id
            WHERE srp.section_id IN (?)
        `, [sectionIds]);

        const sectionsWithPermissions = sections.map(section => {
            section.allowed_roles = permissions
                                    .filter(p => p.section_id === section.id)
                                    .map(p => p.name);
            return section;
        });

        res.json(sectionsWithPermissions);
    } catch (err) {
        console.error('Error fetching section permissions for admin:', err);
        res.status(500).json({ error: 'Failed to load section permissions.' });
    }
});

app.post('/api/admin/forum-section-permissions/:sectionId', authMiddleware, adminMiddleware, async (req, res) => {
    const sectionId = req.params.sectionId;
    const { allowedRoleNames } = req.body;

    if (!Array.isArray(allowedRoleNames)) {
        return res.status(400).json({ error: 'allowedRoleNames must be an array.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        await connection.query('DELETE FROM section_role_permissions WHERE section_id = ?', [sectionId]);

        if (allowedRoleNames.length > 0) {
            const [rolesToAssign] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [allowedRoleNames]);
            if (rolesToAssign.length !== allowedRoleNames.length) {
                await connection.rollback();
                return res.status(400).json({ error: 'One or more provided role names are invalid.' });
            }

            const insertValues = rolesToAssign.map(role => [sectionId, role.id]);
            await connection.query('INSERT INTO section_role_permissions (section_id, role_id) VALUES ?', [insertValues]);
        }

        await connection.commit();
        res.json({ message: 'Section permissions updated successfully.' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error updating section permissions:', err);
        res.status(500).json({ error: 'Failed to update section permissions.' });
    } finally {
        if (connection) connection.release();
    }
});

// API Routes for Polls
// NEW: API to create a new poll (Admin only)
app.post('/api/admin/polls', authMiddleware, adminMiddleware, async (req, res) => {
    const { question, options } = req.body;
    const userId = req.session.userId;

    if (!question || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: 'Poll must have a question and at least two options.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Insert the new poll
        const [pollResult] = await connection.query(
            'INSERT INTO polls (user_id, question) VALUES (?, ?)',
            [userId, question]
        );
        const newPollId = pollResult.insertId;

        // 2. Insert the poll options
        const optionValues = options.map(opt => [newPollId, opt]);
        await connection.query(
            'INSERT INTO poll_options (poll_id, option_text) VALUES ?',
            [optionValues]
        );

        await connection.commit();
        res.status(201).json({ message: 'Poll created successfully!', pollId: newPollId });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error creating poll:', err);
        res.status(500).json({ error: 'Failed to create poll.' });
    } finally {
        if (connection) connection.release();
    }
});

// NEW: API to get the current active poll and user's vote
app.get('/api/polls/active', authMiddleware, async (req, res) => {
    const userId = req.session.userId;

    try {
        // Fetch the latest active poll
        const [activePoll] = await pool.query('SELECT id, question FROM polls WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1');

        if (activePoll.length === 0) {
            return res.status(404).json({ error: 'No active poll found.' });
        }

        const poll = activePoll[0];

        // Fetch options for the poll
        const [options] = await pool.query('SELECT id, option_text FROM poll_options WHERE poll_id = ?', [poll.id]);
        
        // Fetch vote count for each option
        const [voteCounts] = await pool.query('SELECT option_id, COUNT(*) AS count FROM poll_votes WHERE poll_id = ? GROUP BY option_id', [poll.id]);

        // Fetch user's vote if they have voted
        const [userVote] = await pool.query('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, userId]);

        const pollData = {
            id: poll.id,
            question: poll.question,
            options: options.map(opt => ({
                id: opt.id,
                text: opt.option_text,
                votes: voteCounts.find(vc => vc.option_id === opt.id)?.count || 0
            })),
            total_votes: voteCounts.reduce((sum, vc) => sum + vc.count, 0),
            has_voted: userVote.length > 0,
            user_vote_id: userVote.length > 0 ? userVote[0].option_id : null
        };
        
        res.json(pollData);

    } catch (err) {
        console.error('Error fetching active poll:', err);
        res.status(500).json({ error: 'Failed to fetch poll data.' });
    }
});

// NEW: API to submit a vote on a poll
app.post('/api/polls/:pollId/vote', authMiddleware, async (req, res) => {
    const { pollId } = req.params;
    const { optionId } = req.body;
    const userId = req.session.userId;

    if (!optionId) {
        return res.status(400).json({ error: 'Option ID is required.' });
    }

    try {
        // Check if the poll is active
        const [pollCheck] = await pool.query('SELECT id, is_active FROM polls WHERE id = ?', [pollId]);
        if (pollCheck.length === 0 || !pollCheck[0].is_active) {
            return res.status(404).json({ error: 'Poll not found or is not active.' });
        }
        
        // Check if the option belongs to the poll
        const [optionCheck] = await pool.query('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?', [optionId, pollId]);
        if (optionCheck.length === 0) {
            return res.status(400).json({ error: 'Invalid option selected for this poll.' });
        }

        // Check if the user has already voted
        const [existingVote] = await pool.query('SELECT user_id FROM poll_votes WHERE user_id = ? AND poll_id = ?', [userId, pollId]);
        if (existingVote.length > 0) {
            return res.status(409).json({ error: 'You have already voted on this poll.' });
        }

        // Record the vote
        await pool.query(
            'INSERT INTO poll_votes (user_id, poll_id, option_id) VALUES (?, ?, ?)',
            [userId, pollId, optionId]
        );

        res.json({ message: 'Vote cast successfully!' });

    } catch (err) {
        console.error('Error casting vote:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'You have already voted on this poll.' });
        }
        res.status(500).json({ error: 'Failed to cast vote.' });
    }
});

// NEW: API to deactivate a poll (Admin only)
app.put('/api/admin/polls/:pollId/deactivate', authMiddleware, adminMiddleware, async (req, res) => {
    const { pollId } = req.params;
    try {
        const [result] = await pool.query('UPDATE polls SET is_active = 0 WHERE id = ?', [pollId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Poll not found.' });
        }
        res.json({ message: 'Poll deactivated successfully.' });
    } catch (err) {
        console.error('Error deactivating poll:', err);
        res.status(500).json({ error: 'Failed to deactivate poll.' });
    }
});

// API Routes for Forum Core Functionality
app.get('/api/forum/sections', async (req, res) => {
    try {
        const [sections] = await pool.query('SELECT id, name, description, topic_count, post_count, last_activity_at FROM forum_sections ORDER BY last_activity_at DESC');
        res.json(sections);
    } catch (err) {
        console.error('Error fetching forum sections:', err);
        res.status(500).json({ error: 'Failed to load forum sections' });
    }
});

// MODIFIED: /api/forum/sections/:sectionId/topics to filter private topics
app.get('/api/forum/sections/:sectionId/topics', authMiddleware, async (req, res) => {
    const { sectionId } = req.params;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [sectionCheck] = await connection.query('SELECT id FROM forum_sections WHERE id = ?', [sectionId]);
        if (sectionCheck.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Forum section not found.' });
        }

        // Check if user has general access to the section
        if (!userRoles.includes('Admin')) {
            const [userRoleIds] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [userRoles]);
            const userRoleIdsArray = userRoleIds.map(r => r.id);

            if (userRoleIdsArray.length === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. You do not have any roles assigned to access forum sections.' });
            }

            const [permissionCheck] = await connection.query(`
                SELECT COUNT(*) AS count FROM section_role_permissions
                WHERE section_id = ? AND role_id IN (?)
            `, [sectionId, userRoleIdsArray]);

            if (permissionCheck[0].count === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. Your roles do not permit access to this section.' });
            }
        }

        // Fetch topics: public topics only
        const [topics] = await connection.query(`
            SELECT t.id, t.title, t.views, t.reply_count, t.created_at, t.last_post_at,
                   u.username, u.reputation_points, t.upvotes, t.downvotes, t.is_locked, t.is_sticky,
                   t.user_id, t.is_private, -- Include is_private column
                   (
                       SELECT r.name
                       FROM user_roles ur_sub
                       JOIN roles r ON ur_sub.role_id = r.id
                       WHERE ur_sub.user_id = u.id
                       ORDER BY FIELD(r.name, 'Admin', 'Faculty', 'Moderator', 'Student') DESC, r.name ASC
                       LIMIT 1
                   ) AS author_display_role
            FROM topics t
            JOIN users u ON t.user_id = u.id
            WHERE t.section_id = ? AND t.is_private = FALSE -- Only show public topics in sections
            ORDER BY t.is_sticky DESC, t.last_post_at DESC
        `, [sectionId]);

        await connection.commit();
        res.json(topics);

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error fetching topics for section with access check:', err);
        res.status(500).json({ error: 'Failed to load topics due to server error.' });
    } finally {
        if (connection) connection.release();
    }
});


// MODIFIED: /api/forum/sections/:sectionId/topics for creating private topics
app.post('/api/forum/sections/:sectionId/topics', authMiddleware, async (req, res) => {
    const { sectionId } = req.params;
    const { title, content, is_private, grantedUsernames } = req.body; // Added is_private and grantedUsernames
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    if (!title || !content) {
        return res.status(400).json({ error: 'Title and content are required' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [sectionCheck] = await connection.query('SELECT id FROM forum_sections WHERE id = ?', [sectionId]);
        if (sectionCheck.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Forum section not found.' });
        }

        // Permission check to post in a section (existing logic)
        if (!userRoles.includes('Admin')) {
            const [userRoleIds] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [userRoles]);
            const userRoleIdsArray = userRoleIds.map(r => r.id);

            if (userRoleIdsArray.length === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. You do not have any roles assigned to post in forum sections.' });
            }

            const [permissionCheck] = await connection.query(`
                SELECT COUNT(*) AS count FROM section_role_permissions
                WHERE section_id = ? AND role_id IN (?)
            `, [sectionId, userRoleIdsArray]);

            if (permissionCheck[0].count === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. Your roles do not permit posting in this section.' });
            }
        }
        
        // Faculty (or Admin) can create private topics
        const canCreatePrivate = userRoles.includes('Admin') || userRoles.includes('Faculty');
        if (is_private && !canCreatePrivate) {
            await connection.rollback();
            return res.status(403).json({ error: 'Only Faculty and Admin can create private topics.' });
        }

        const [topicResult] = await connection.query(
            'INSERT INTO topics (section_id, user_id, title, content, created_at, last_post_at, is_private) VALUES (?, ?, ?, ?, NOW(), NOW(), ?)',
            [sectionId, userId, title, content, is_private ? 1 : 0] // Save is_private flag
        );
        const newTopicId = topicResult.insertId;

        await connection.query(
            'INSERT INTO posts (topic_id, user_id, content, created_at) VALUES (?, ?, ?, NOW())',
            [newTopicId, userId, content]
        );

        await connection.query(
            'UPDATE forum_sections SET topic_count = topic_count + 1, post_count = post_count + 1, last_activity_at = NOW() WHERE id = ?',
            [sectionId]
        );

        await connection.query(
            'UPDATE users SET reputation_points = reputation_points + ? WHERE id = ?',
            [1, userId]
        );
        await connection.query(
            'INSERT INTO reputation_events (user_id, source_user_id, event_type, entity_type, entity_id, points_awarded) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, null, 'TOPIC_CREATED', 'TOPIC', newTopicId, 1]
        );

        // If private, grant access to the creator and specified users
        if (is_private && canCreatePrivate) {
            // Grant access to the creator (always)
            await connection.query(
                'INSERT INTO private_post_access (private_post_id, user_id) VALUES (?, ?)',
                [newTopicId, userId]
            );

            if (grantedUsernames && grantedUsernames.length > 0) {
                const [grantedUserIds] = await connection.query('SELECT id, username FROM users WHERE username IN (?)', [grantedUsernames]);
                
                for (const grantedUser of grantedUserIds) {
                    try {
                        await connection.query(
                            'INSERT INTO private_post_access (private_post_id, user_id) VALUES (?, ?)',
                            [newTopicId, grantedUser.id]
                        );
                        // Notify granted user outside transaction
                        process.nextTick(async () => {
                            try {
                                await createNotification(grantedUser.id, 'private_post_access', newTopicId, 'topic', userId);
                                // Also send a private message
                                await pool.query(
                                    'INSERT INTO private_messages (sender_id, receiver_id, subject, content) VALUES (?, ?, ?, ?)',
                                    [userId, grantedUser.id, `Access Granted: Private Topic "${title}"`, `Hello ${grantedUser.username},\n\n${req.session.username} has granted you access to a private topic: "${title}".\n\nView topic: /forum/topics/${newTopicId}`]
                                );
                            } catch (notificationErr) {
                                console.error('Error sending private topic access notification (non-blocking):', notificationErr);
                            }
                        });

                    } catch (dupEntryErr) {
                        if (dupEntryErr.code === 'ER_DUP_ENTRY') {
                            console.warn(`User ${grantedUser.username} already has access to topic ${newTopicId}.`);
                        } else {
                            throw dupEntryErr; // Re-throw other errors
                        }
                    }
                }
            }
        }


        await connection.commit();
        res.status(201).json({ id: newTopicId, title, content, section_id: sectionId, is_private, message: 'Topic created successfully' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error creating topic with access check:', err);
        res.status(500).json({ error: 'Failed to create topic due to server error.' });
    } finally {
        if (connection) connection.release();
    }
});


// MODIFIED: /api/forum/topics/:topicId to enforce private topic access
app.get('/api/forum/topics/:topicId', authMiddleware, async (req, res) => {
    const { topicId } = req.params;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [topicRows] = await connection.query(`
            SELECT
                t.id, t.section_id, t.user_id, t.title, t.content AS topic_content, t.created_at,
                t.last_post_at, t.reply_count, t.views, t.is_locked, t.is_sticky, t.upvotes, t.downvotes, t.updated_at,
                t.is_private, -- Fetch is_private
                u.username, u.reputation_points,
                (
                    SELECT r.name
                    FROM user_roles ur_sub
                    JOIN roles r ON ur_sub.role_id = r.id
                    WHERE ur_sub.user_id = u.id
                    ORDER BY FIELD(r.name, 'Admin', 'Faculty', 'Moderator', 'Student') DESC, r.name ASC
                    LIMIT 1
                ) AS author_display_role
            FROM topics t
            JOIN users u ON t.user_id = u.id
            WHERE t.id = ?
        `, [topicId]);

        if (topicRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Topic not found.' });
        }

        const topic = topicRows[0];

        // NEW: Private topic access check
        if (topic.is_private) {
            // Only topic owner or an Admin can access, OR users explicitly granted access
            if (topic.user_id !== userId && !userRoles.includes('Admin')) {
                const [accessCheck] = await connection.query(
                    'SELECT COUNT(*) AS count FROM private_post_access WHERE private_post_id = ? AND user_id = ?',
                    [topicId, userId]
                );
                if (accessCheck[0].count === 0) {
                    await connection.rollback();
                    return res.status(403).json({ error: 'Access denied. This is a private topic.' });
                }
            }
        }
        // Access control for section viewing (existing logic)
        else if (!userRoles.includes('Admin')) { // Apply section permissions only if not private and not admin
            const [userRoleIds] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [userRoles]);
            const userRoleIdsArray = userRoleIds.map(r => r.id);

            if (userRoleIdsArray.length === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. You do not have any roles assigned to view forum sections.' });
            }

            const [permissionCheck] = await connection.query(`
                SELECT COUNT(*) AS count FROM section_role_permissions
                WHERE section_id = ? AND role_id IN (?)
            `, [topic.section_id, userRoleIdsArray]);

            if (permissionCheck[0].count === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. Your roles do not permit access to this section.' });
            }
        }

        const [posts] = await connection.query(`
            SELECT
                p.id, p.user_id, p.content, p.created_at, p.updated_at, p.upvotes, p.downvotes,
                u.username, u.reputation_points,
                (
                    SELECT r.name
                    FROM user_roles ur_sub
                    JOIN roles r ON ur_sub.role_id = r.id
                    WHERE ur_sub.user_id = u.id
                    ORDER BY FIELD(r.name, 'Admin', 'Faculty', 'Moderator', 'Student') DESC, r.name ASC
                    LIMIT 1
                ) AS author_display_role
            FROM posts p
            JOIN users u ON p.user_id = u.id
            WHERE p.topic_id = ?
            ORDER BY p.created_at ASC
        `, [topicId]);

        if (posts.length > 0) {
            topic.content = posts[0].content;
        } else {
            topic.content = '';
        }

        await connection.commit();

        pool.query('UPDATE topics SET views = views + 1 WHERE id = ?', [topicId])
            .catch(err => console.error('Error incrementing topic views (non-blocking):', err));

        res.json({ topic: topic, posts: posts });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error fetching topic and posts:', err);
        res.status(500).json({ error: 'Failed to load topic due to server error.' });
    } finally {
        if (connection) connection.release();
    }
});


// API for posting a reply to a topic (no changes needed here, as access is checked by topic route)
app.post('/api/forum/topics/:topicId/posts', authMiddleware, async (req, res) => {
    const { topicId } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Reply content cannot be empty.' });
    }

    let connection;
    let topicOwnerId = null;
    let newPostId = null;
    let section_id = null;
    let otherParticipants = [];

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [topicInfo] = await connection.query('SELECT user_id, is_locked, section_id FROM topics WHERE id = ?', [topicId]);
        if (topicInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Topic not found.' });
        }

        topicOwnerId = topicInfo[0].user_id;
        const is_locked = topicInfo[0].is_locked;
        section_id = topicInfo[0].section_id;

        if (is_locked) {
            await connection.rollback();
            return res.status(403).json({ error: 'This topic is locked and cannot receive new replies.' });
        }

        const [postResult] = await connection.query(
            'INSERT INTO posts (topic_id, user_id, content, created_at) VALUES (?, ?, ?, NOW())',
            [topicId, userId, content]
        );
        newPostId = postResult.insertId;

        await connection.query('UPDATE topics SET reply_count = reply_count + 1, last_post_at = NOW() WHERE id = ?', [topicId]);
        await connection.query('UPDATE forum_sections SET post_count = post_count + 1, last_activity_at = NOW() WHERE id = ?', [section_id]);

        // Update reputation for posting a reply
        await connection.query(
            'UPDATE users SET reputation_points = reputation_points + ? WHERE id = ?',
            [1, userId]
        );
        await connection.query(
            'INSERT INTO reputation_events (user_id, source_user_id, event_type, entity_type, entity_id, points_awarded) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, null, 'POST_CREATED', 'POST', newPostId, 1]
        );

        // Fetch other participants within this transaction before commit
        const [fetchedParticipants] = await connection.query(`
            SELECT DISTINCT user_id FROM posts
            WHERE topic_id = ? AND user_id != ? AND user_id != ?
        `, [topicId, topicOwnerId, userId]);
        otherParticipants = fetchedParticipants;


        await connection.commit();

        // Create notifications OUTSIDE the main transaction
        try {
            // Notify topic owner if different from replier
            if (topicOwnerId !== userId) {
                await createNotification(topicOwnerId, 'new_topic_reply', topicId, 'topic', userId);
            }

            // Notify other participants in the topic
            for (const participant of otherParticipants) {
                await createNotification(participant.user_id, 'new_post_reply', newPostId, 'post', userId);
            }
        } catch (notificationError) {
            console.error('Error creating notifications after post commit (non-blocking):', notificationError);
        }

        res.status(201).json({ id: newPostId, message: 'Reply posted successfully!' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error posting reply:', err);
        res.status(500).json({ error: 'Failed to post reply due to server error.' });
    } finally {
        if (connection) connection.release();
    }
});

app.put('/api/forum/topics/:topicId', authMiddleware, async (req, res) => {
    const { topicId } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Content cannot be empty.' });
    }

    try {
        const [topic] = await pool.query('SELECT user_id FROM topics WHERE id = ?', [topicId]);
        if (topic.length === 0) {
            return res.status(404).json({ error: 'Topic not found.' });
        }

        if (topic[0].user_id !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'Unauthorized to edit this topic.' });
        }

        await pool.query('UPDATE topics SET content = ?, updated_at = NOW() WHERE id = ?', [content, topicId]);
        await pool.query('UPDATE posts SET content = ?, updated_at = NOW() WHERE topic_id = ? ORDER BY created_at ASC LIMIT 1', [content, topicId]);

        res.json({ message: 'Topic updated successfully.' });
    } catch (err) {
        console.error('Error updating topic:', err);
        res.status(500).json({ error: 'Failed to update topic.' });
    }
});

app.delete('/api/forum/topics/:topicId', authMiddleware, adminMiddleware, async (req, res) => {
    const { topicId } = req.params;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [topic] = await connection.query('SELECT user_id, section_id, reply_count FROM topics WHERE id = ?', [topicId]);
        if (topic.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Topic not found.' });
        }

        const sectionId = topic[0].section_id;
        const repliesInTopic = (typeof topic[0].reply_count === 'number' ? topic[0].reply_count : 0);

        await connection.query('DELETE FROM votes WHERE entity_type = "TOPIC" AND entity_id = ?', [topicId]);
        await connection.query('DELETE FROM votes WHERE entity_type = "POST" AND entity_id IN (SELECT id FROM posts WHERE topic_id = ?)', [topicId]);
        await connection.query('DELETE FROM reputation_events WHERE entity_type = "TOPIC" AND entity_id = ?', [topicId]);
        await connection.query('DELETE FROM reputation_events WHERE entity_type = "POST" AND entity_id IN (SELECT id FROM posts WHERE topic_id = ?)', [topicId]);
        await connection.query('DELETE FROM posts WHERE topic_id = ?', [topicId]); // Delete all posts related to the topic

        const [result] = await connection.query('DELETE FROM topics WHERE id = ?', [topicId]);
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Topic not found or already deleted.' });
        }

        await connection.query('UPDATE forum_sections SET topic_count = topic_count - 1, post_count = post_count - ? WHERE id = ?',
            [repliesInTopic + 1, sectionId]);

        await connection.commit();
        res.json({ message: 'Topic and associated posts deleted successfully.' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error deleting topic:', err);
        res.status(500).json({ error: 'Failed to delete topic.' });
    } finally {
        if (connection) connection.release();
    }
});

app.put('/api/forum/posts/:postId', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Content cannot be empty.' });
    }

    try {
        const [post] = await pool.query('SELECT user_id FROM posts WHERE id = ?', [postId]);
        if (post.length === 0) {
            return res.status(404).json({ error: 'Post not found.' });
        }

        if (post[0].user_id !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'Unauthorized to edit this post.' });
        }

        await pool.query('UPDATE posts SET content = ?, updated_at = NOW() WHERE id = ?', [content, postId]);
        res.json({ message: 'Post updated successfully.' });
    } catch (err) {
        console.error('Error updating post:', err);
        res.status(500).json({ error: 'Failed to update post.' });
    }
});

app.delete('/api/forum/posts/:postId', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [post] = await pool.query('SELECT user_id, topic_id FROM posts WHERE id = ?', [postId]);
        if (post.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Post not found.' });
        }

        if (post[0].user_id !== userId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to delete this post.' });
        }

        const topicId = post[0].topic_id;

        // Prevent deletion of the very first post (which represents the topic content)
        const [originalTopicPost] = await connection.query('SELECT id FROM posts WHERE topic_id = ? ORDER BY created_at ASC LIMIT 1', [topicId]);
        if (originalTopicPost.length > 0 && originalTopicPost[0].id === parseInt(postId)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Cannot delete the original topic post. Delete the entire topic instead.' });
        }

        await connection.query('DELETE FROM votes WHERE entity_type = "POST" AND entity_id = ?', [postId]);
        await connection.query('DELETE FROM reputation_events WHERE entity_type = "POST" AND entity_id = ?', [postId]);

        const [result] = await connection.query('DELETE FROM posts WHERE id = ?', [postId]);
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Post not found or already deleted.' });
        }

        await connection.query('UPDATE topics SET reply_count = reply_count - 1, last_post_at = NOW() WHERE id = ?', [topicId]);

        const [topicInfo] = await connection.query('SELECT section_id FROM topics WHERE id = ?', [topicId]);
        if (topicInfo.length > 0) {
            await connection.query('UPDATE forum_sections SET post_count = post_count - 1, last_activity_at = NOW() WHERE id = ?', [topicInfo[0].section_id]);
        }

        await connection.commit();
        res.json({ message: 'Post deleted successfully.' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error deleting post:', err);
        res.status(500).json({ error: 'Failed to delete post.' });
    } finally {
        if (connection) connection.release();
    }
});

// Allows Faculty and Admin to lock/unlock topics
app.put('/api/forum/topics/:topicId/lock', authMiddleware, async (req, res) => {
    const { topicId } = req.params;
    const { is_locked } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (typeof is_locked !== 'boolean') {
        return res.status(400).json({ error: 'Invalid value for is_locked. Must be true or false.' });
    }

    try {
        const [topicInfo] = await pool.query('SELECT user_id FROM topics WHERE id = ?', [topicId]);
        if (topicInfo.length === 0) {
            return res.status(404).json({ error: 'Topic not found.' });
        }
        
        const topicOwnerId = topicInfo[0].user_id;

        // Allow Admin or the topic owner (Faculty) to lock/unlock the topic
        if (!userRoles.includes('Admin') && !(userRoles.includes('Faculty') && topicOwnerId === userId)) {
             return res.status(403).json({ error: 'Unauthorized to change lock status of this topic.' });
        }

        const [result] = await pool.query('UPDATE topics SET is_locked = ? WHERE id = ?', [is_locked, topicId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Topic not found.' });
        }
        res.json({ message: `Topic ${is_locked ? 'locked' : 'unlocked'} successfully.` });
    } catch (err) {
        console.error('Error updating topic lock status:', err);
        res.status(500).json({ error: 'Failed to update topic lock status.' });
    }
});

// API Routes for Voting
app.post('/api/vote/:entityType/:entityId', authMiddleware, async (req, res) => {
    const { entityType, entityId } = req.params;
    const { voteType } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    if (!['topic', 'post'].includes(entityType)) {
        return res.status(400).json({ error: 'Invalid entity type. Must be "topic" or "post".' });
    }
    if (![1, -1].includes(voteType)) {
        return res.status(400).json({ error: 'Invalid vote type. Must be 1 (upvote) or -1 (downvote).' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        let entityTable, authorColumn, relatedSectionId = null;
        if (entityType === 'topic') {
            entityTable = 'topics';
            authorColumn = 'user_id';
            const [topicInfo] = await connection.query('SELECT section_id FROM topics WHERE id = ?', [entityId]);
            if (topicInfo.length > 0) relatedSectionId = topicInfo[0].section_id;
        } else {
            entityTable = 'posts';
            authorColumn = 'user_id';
            const [postInfo] = await connection.query('SELECT t.section_id FROM posts p JOIN topics t ON p.topic_id = t.id WHERE p.id = ?', [entityId]);
            if (postInfo.length > 0) relatedSectionId = postInfo[0].section_id;
        }

        if (relatedSectionId && !userRoles.includes('Admin')) {
            const [userRoleIds] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [userRoles]);
            const userRoleIdsArray = userRoleIds.map(r => r.id);

            if (userRoleIdsArray.length === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. You do not have any roles assigned to vote in this section.' });
            }

            const [permissionCheck] = await connection.query(`
                SELECT COUNT(*) AS count FROM section_role_permissions
                WHERE section_id = ? AND role_id IN (?)
            `, [relatedSectionId, userRoleIdsArray]);

            if (permissionCheck[0].count === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. Your roles do not permit voting in this section.' });
            }
        }

        const [existingVote] = await connection.query(
            'SELECT vote_type FROM votes WHERE user_id = ? AND entity_type = ? AND entity_id = ?',
            [userId, entityType.toUpperCase(), entityId]
        );

        if (existingVote.length > 0) {
            const oldVoteType = existingVote[0].vote_type;
            if (oldVoteType === voteType) {
                // User is trying to vote the same way again, so remove the vote
                if (voteType === 1) {
                    await connection.query(`UPDATE ${entityTable} SET upvotes = upvotes - 1 WHERE id = ?`, [entityId]);
                } else {
                    await connection.query(`UPDATE ${entityTable} SET downvotes = downvotes - 1 WHERE id = ?`, [entityId]);
                }
                await connection.query('DELETE FROM votes WHERE user_id = ? AND entity_type = ? AND entity_id = ?',
                    [userId, entityType.toUpperCase(), entityId]);

                const [entityAuthor] = await connection.query(`SELECT ${authorColumn} AS author_id FROM ${entityTable} WHERE id = ?`, [entityId]);
                if (entityAuthor.length > 0) {
                    const authorId = entityAuthor[0].author_id;
                    const pointsChange = (voteType === 1) ? -5 : 2; // Reverse the points for removing a vote
                    await connection.query('UPDATE users SET reputation_points = reputation_points + ? WHERE id = ?', [pointsChange, authorId]);
                    await connection.query('INSERT INTO reputation_events (user_id, source_user_id, event_type, entity_type, entity_id, points_awarded) VALUES (?, ?, ?, ?, ?, ?)',
                        [authorId, userId, (voteType === 1) ? 'UPVOTE_REMOVED' : 'DOWNVOTE_REMOVED', entityType.toUpperCase(), entityId, pointsChange]);
                }

                await connection.commit();
                return res.json({ message: `${entityType} vote removed successfully.` });

            } else {
                // User is changing their vote (e.g., from upvote to downvote or vice-versa)
                if (oldVoteType === 1 && voteType === -1) {
                    await connection.query(`UPDATE ${entityTable} SET upvotes = upvotes - 1, downvotes = downvotes + 1 WHERE id = ?`, [entityId]);
                } else if (oldVoteType === -1 && voteType === 1) {
                    await connection.query(`UPDATE ${entityTable} SET upvotes = upvotes + 1, downvotes = downvotes - 1 WHERE id = ?`, [entityId]);
                }
                await connection.query('UPDATE votes SET vote_type = ? WHERE user_id = ? AND entity_type = ? AND entity_id = ?',
                    [voteType, userId, entityType.toUpperCase(), entityId]);

                const [entityAuthor] = await connection.query(`SELECT ${authorColumn} AS author_id FROM ${entityTable} WHERE id = ?`, [entityId]);
                if (entityAuthor.length > 0) {
                    const authorId = entityAuthor[0].author_id;
                    let pointsChange = 0;
                    if (oldVoteType === 1 && voteType === -1) pointsChange = -7; // -5 (upvote removed) + -2 (downvote added)
                    else if (oldVoteType === -1 && voteType === 1) pointsChange = 7; // +2 (downvote removed) + 5 (upvote added)
                    await connection.query('UPDATE users SET reputation_points = reputation_points + ? WHERE id = ?', [pointsChange, authorId]);
                    await connection.query('INSERT INTO reputation_events (user_id, source_user_id, event_type, entity_type, entity_id, points_awarded) VALUES (?, ?, ?, ?, ?, ?)',
                        [authorId, userId, 'VOTE_CHANGED', entityType.toUpperCase(), entityId, pointsChange]);
                }

                await connection.commit();
                return res.json({ message: `${entityType} vote changed successfully.` });
            }
        } else {
            // New vote
            if (voteType === 1) {
                await connection.query(`UPDATE ${entityTable} SET upvotes = upvotes + 1 WHERE id = ?`, [entityId]);
            } else {
                await connection.query(`UPDATE ${entityTable} SET downvotes = downvotes + 1 WHERE id = ?`, [entityId]);
            }
            await connection.query('INSERT INTO votes (user_id, entity_type, entity_id, vote_type) VALUES (?, ?, ?, ?)',
                [userId, entityType.toUpperCase(), entityId, voteType]);

            const [entityAuthor] = await connection.query(`SELECT ${authorColumn} AS author_id FROM ${entityTable} WHERE id = ?`, [entityId]);
            if (entityAuthor.length > 0) {
                const authorId = entityAuthor[0].author_id;
                const pointsChange = (voteType === 1) ? 5 : -2;
                await connection.query('UPDATE users SET reputation_points = reputation_points + ? WHERE id = ?', [pointsChange, authorId]);
                await connection.query('INSERT INTO reputation_events (user_id, source_user_id, event_type, entity_type, entity_id, points_awarded) VALUES (?, ?, ?, ?, ?, ?)',
                    [authorId, userId, (voteType === 1) ? 'UPVOTED' : 'DOWNVOTED', entityType.toUpperCase(), entityId, pointsChange]);
            }

            await connection.commit();
            return res.json({ message: `${entityType} voted successfully.` });
        }

    } catch (err) {
        if (connection) await connection.rollback();
        if (err.code === 'ER_DUP_ENTRY') {
             return res.status(409).json({ error: 'You have already cast a vote on this item.' });
        }
        console.error('Error casting vote:', err);
        res.status(500).json({ error: 'Failed to cast vote.' });
    } finally {
        if (connection) connection.release();
    }
});

// API Routes for Announcements
// Allows Faculty and Admin to post announcements
app.post('/api/announcements', authMiddleware, async (req, res) => {
    // Check for both Admin and Faculty roles
    if (!req.session.roles.includes('Admin') && !req.session.roles.includes('Faculty')) {
        return res.status(403).json({ error: 'Access denied. You must be an Admin or Faculty member to post announcements.' });
    }
    const { title, content } = req.body;
    const userId = req.session.userId;

    if (!title || !content) {
        return res.status(400).json({ error: 'Title and content are required for an announcement.' });
    }

    try {
        await pool.query('INSERT INTO announcements (user_id, title, content) VALUES (?, ?, ?)',
            [userId, title, content]);
        res.status(201).json({ message: 'Announcement posted successfully!' });
    } catch (err) {
        console.error('Error posting announcement:', err);
        res.status(500).json({ error: 'Failed to post announcement.' });
    }
});

app.get('/api/announcements', authMiddleware, async (req, res) => {
    try {
        const [announcements] = await pool.query(`
            SELECT a.id, a.title, a.content, a.created_at, u.username AS author_username, a.user_id
            FROM announcements a
            JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC
        `);
        res.json(announcements);
    } catch (err) {
        console.error('Error fetching announcements:', err);
        res.status(500).json({ error: 'Failed to load announcements.' });
    }
});

// Allows Admin and the author (Faculty/Admin) to delete an announcement
app.delete('/api/announcements/:id', authMiddleware, async (req, res) => {
    const announcementId = req.params.id;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    try {
        const [announcement] = await pool.query('SELECT user_id FROM announcements WHERE id = ?', [announcementId]);
        if (announcement.length === 0) {
            return res.status(404).json({ error: 'Announcement not found.' });
        }

        // Authorization check: User must be the author OR an Admin
        if (announcement[0].user_id !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'Unauthorized to delete this announcement.' });
        }
        
        const [result] = await pool.query('DELETE FROM announcements WHERE id = ?', [announcementId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Announcement not found or already deleted.' });
        }
        res.json({ message: 'Announcement deleted successfully.' });
    } catch (err) {
        console.error('Error deleting announcement:', err);
        res.status(500).json({ error: 'Failed to delete announcement.' });
    }
});

// UIU Notice Scraping
const UIU_NOTICE_URL = 'https://www.uiu.ac.bd/notice/';

async function scrapeAndPostUiuNotices() {
    if (!SYSTEM_ANNOUNCER_USER_ID) {
        const warning = "Scraping aborted: SYSTEM_ANNOUNCER_USER_ID is not configured in .env. Automated announcements will fail.";
        console.error(warning);
        return { success: false, message: warning };
    }

    try {
        console.log(`[Scraper] Attempting to fetch notices from: ${UIU_NOTICE_URL}`);
        const response = await axios.get(UIU_NOTICE_URL, { timeout: 15000 });
        const $ = cheerio.load(response.data);
        const notices = [];

        $('div.blog-post-item').each((i, el) => {
            const titleElement = $(el).find('h2.blog-title a');
            const title = titleElement.text().trim();
            const link = titleElement.attr('href');
            const dateElement = $(el).find('span.posted-on time');
            let date = dateElement.attr('datetime') || dateElement.text().trim();

            if (title && link) {
                const fullLink = link.startsWith('http') ? link : `https://www.uiu.ac.bd${link}`;
                notices.push({ title, link: fullLink, date });
            } else {
                console.warn(`[Scraper] Skipped malformed notice item: title="${title}", link="${link}"`);
            }
        });

        if (notices.length === 0) {
            console.log("[Scraper] No notices found with current selectors. UIU website structure might have changed.");
            return { success: true, message: "Scraping completed, but no new notices were identified with current selectors." };
        }

        console.log(`[Scraper] Scraped ${notices.length} potential notices from UIU.`);

        let postedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const notice of notices) {
            try {
                // Check if an announcement with the same title or link (from SYSTEM_ANNOUNCER_USER_ID) already exists
                const [existingNotices] = await pool.query(
                    'SELECT id FROM announcements WHERE title = ? OR (content LIKE ? AND user_id = ?)',
                    [notice.title, `%${notice.link}%`, SYSTEM_ANNOUNCER_USER_ID]
                );

                if (existingNotices.length > 0) {
                    skippedCount++;
                    continue;
                }

                const content = `**UIU Notice:**\n${notice.title}\n\nSee original notice: ${notice.link}\n${notice.date ? `Date: ${notice.date}\n` : ''}`;

                await pool.query('INSERT INTO announcements (user_id, title, content) VALUES (?, ?, ?)',
                    [SYSTEM_ANNOUNCER_USER_ID, notice.title, content]);
                postedCount++;
                console.log(`[Scraper] Posted new announcement: "${notice.title}"`);
            } catch (innerError) {
                errorCount++;
                console.error(`[Scraper] Error processing notice "${notice.title}":`, innerError.message);
            }
        }

        const finalMessage = `Scraping complete. Posted ${postedCount} new announcements. Skipped ${skippedCount} existing notices. Errors: ${errorCount}.`;
        console.log(`[Scraper] ${finalMessage}`);
        return { success: true, message: finalMessage };

    } catch (error) {
        console.error('[Scraper] Critical error during UIU notice scraping:', error.message);
        if (error.response) {
            console.error(`[Scraper] HTTP Error Status: ${error.response.status}, Data: ${error.response.data}`);
            return { success: false, message: `Scraping failed: HTTP error (${error.response.status}).` };
        } else if (error.request) {
            console.error(`[Scraper] No response received: ${error.request}`);
            return { success: false, message: `Scraping failed: No response from UIU website. It might be down or blocked.` };
        } else {
            return { success: false, message: `Scraping failed: ${error.message}` };
        }
    }
}

app.post('/admin/scrape-uiu-notices', authMiddleware, adminMiddleware, async (req, res) => {
    console.log("UIU Notice Scrape Triggered by Admin.");
    const result = await scrapeAndPostUiuNotices();
    if (result.success) {
        res.json({ message: result.message });
    } else {
        res.status(500).json({ error: result.message });
    }
});


// API Routes for Top Contributors
app.get('/api/top-contributors', authMiddleware, async (req, res) => {
    try {
        const [contributors] = await pool.query(`
            SELECT
                u.id,
                u.username,
                u.name,
                u.reputation_points,
                COUNT(p.id) AS post_count,
                (
                    SELECT r.name
                    FROM user_roles ur_sub
                    JOIN roles r ON ur_sub.role_id = r.id
                    WHERE ur_sub.user_id = u.id
                    ORDER BY FIELD(r.name, 'Admin', 'Faculty', 'Moderator', 'Student') DESC, r.name ASC
                    LIMIT 1
                   ) AS display_role
            FROM users u
            LEFT JOIN posts p ON u.id = p.user_id
            GROUP BY u.id, u.username, u.name, u.reputation_points
            ORDER BY post_count DESC
            LIMIT 20;
        `);
        res.json(contributors);
    } catch (err) {
        console.error('Error fetching top contributors:', err);
        res.status(500).json({ error: 'Failed to load top contributors.' });
    }
});


// MODIFIED: /api/forum/search to filter private topics
app.get('/api/forum/search', authMiddleware, async (req, res) => {
    const { query } = req.query;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    if (!query || query.trim() === '') {
        return res.status(400).json({ error: 'Search query cannot be empty.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        let allowedSectionIds = [];
        if (!userRoles.includes('Admin')) {
            const [userRoleIds] = await connection.query('SELECT id FROM roles WHERE name IN (?)', [userRoles]);
            const userRoleIdsArray = userRoleIds.map(r => r.id);

            if (userRoleIdsArray.length === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. You do not have any roles assigned to access forum sections.' });
            }

            const [permittedSections] = await connection.query(`
                SELECT section_id FROM section_role_permissions
                WHERE role_id IN (?)
            `, [userRoleIdsArray]);
            allowedSectionIds = permittedSections.map(s => s.section_id);

            if (allowedSectionIds.length === 0) {
                await connection.rollback();
                return res.status(403).json({ error: 'Access denied. Your roles do not permit access to any forum sections.' });
            }
        }

        const searchTerm = `%${query}%`;

        let topicsQuery = `
            SELECT t.id, t.title, t.content, t.views, t.reply_count, t.created_at, t.last_post_at,
                   t.is_locked, t.is_sticky, t.upvotes, t.downvotes,
                   u.username, u.reputation_points,
                   (
                       SELECT r.name
                       FROM user_roles ur_sub
                       JOIN roles r ON ur_sub.role_id = r.id
                       WHERE ur_sub.user_id = u.id
                       ORDER BY FIELD(r.name, 'Admin', 'Faculty', 'Moderator', 'Student') DESC, r.name ASC
                       LIMIT 1
                   ) AS author_display_role,
                   fs.name AS section_name
            FROM topics t
            JOIN users u ON t.user_id = u.id
            JOIN forum_sections fs ON t.section_id = fs.id
            WHERE (t.title LIKE ? OR t.content LIKE ?)
        `;
        let topicsQueryParams = [searchTerm, searchTerm];

        if (!userRoles.includes('Admin')) {
            topicsQuery += ` AND t.section_id IN (?)`;
            topicsQueryParams.push(allowedSectionIds);
        }
        topicsQuery += ` ORDER BY t.last_post_at DESC LIMIT 50;`;

        const [foundTopics] = await connection.query(topicsQuery, topicsQueryParams);

        let postsQuery = `
            SELECT p.id, p.content, p.created_at, p.updated_at, p.upvotes, p.downvotes,
                   u.username, u.reputation_points,
                   t.id AS topic_id, t.title AS topic_title, t.section_id,
                   (
                       SELECT r.name
                       FROM user_roles ur_sub
                       JOIN roles r ON ur_sub.role_id = r.id
                       WHERE ur_sub.user_id = u.id
                       ORDER BY FIELD(r.name, 'Admin', 'Faculty', 'Moderator', 'Student') DESC, r.name ASC
                       LIMIT 1
                   ) AS author_display_role
            FROM posts p
            JOIN users u ON p.user_id = u.id
            JOIN topics t ON p.topic_id = t.id
            WHERE p.content LIKE ?
        `;
        let postsQueryParams = [searchTerm];

        if (!userRoles.includes('Admin')) {
            postsQuery += ` AND t.section_id IN (?)`;
            postsQueryParams.push(allowedSectionIds);
        }
        postsQuery += ` ORDER BY p.created_at DESC LIMIT 50;`;

        const [foundPosts] = await connection.query(postsQuery, postsQueryParams);

        await connection.commit();
        res.json({ topics: foundTopics, posts: foundPosts });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error during forum search:', err);
        res.status(500).json({ error: 'Server error during search.' });
    } finally {
        if (connection) connection.release();
    }
});

// API Routes for Events
app.get('/api/events', authMiddleware, async (req, res) => {
    try {
        const [events] = await pool.query(`
            SELECT e.id, e.title, e.description, e.event_date, e.location, u.username AS author_username, e.user_id
            FROM events e
            JOIN users u ON e.user_id = u.id
            ORDER BY e.event_date ASC
        `);
        res.json(events);
    } catch (err) {
        console.error('Error fetching events:', err);
        res.status(500).json({ error: 'Failed to load events.' });
    }
});

app.post('/api/events', authMiddleware, async (req, res) => {
    const { title, description, event_date, location } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!userRoles.includes('Admin') && !userRoles.includes('Faculty')) {
        return res.status(403).json({ error: 'You are not authorized to post events.' });
    }

    if (!title || !description || !event_date) {
        return res.status(400).json({ error: 'Title, description, and date are required.' });
    }

    try {
        await pool.query(
            'INSERT INTO events (user_id, title, description, event_date, location) VALUES (?, ?, ?, ?, ?)',
            [userId, title, description, event_date, location]
        );
        res.status(201).json({ message: 'Event created successfully!' });
    } catch (err) {
        console.error('Error creating event:', err);
        res.status(500).json({ error: 'Failed to create event.' });
    }
});

app.put('/api/events/:eventId', authMiddleware, async (req, res) => {
    const { eventId } = req.params;
    const { title, description, event_date, location } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!title || !description || !event_date) {
        return res.status(400).json({ error: 'Title, description, and date are required.' });
    }

    try {
        const [eventRows] = await pool.query('SELECT user_id FROM events WHERE id = ?', [eventId]);
        if (eventRows.length === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }

        const event = eventRows[0];
        if (event.user_id !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'You are not authorized to update this event.' });
        }

        await pool.query(
            'UPDATE events SET title = ?, description = ?, event_date = ?, location = ? WHERE id = ?',
            [title, description, event_date, location, eventId]
        );

        res.json({ message: 'Event updated successfully.' });

    } catch (err) {
        console.error('Error updating event:', err);
        res.status(500).json({ error: 'Failed to update event.' });
    }
});

app.delete('/api/events/:eventId', authMiddleware, async (req, res) => {
    const { eventId } = req.params;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    try {
        const [eventRows] = await pool.query('SELECT user_id FROM events WHERE id = ?', [eventId]);
        if (eventRows.length === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }

        const event = eventRows[0];
        if (event.user_id !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'You are not authorized to delete this event.' });
        }

        const [result] = await pool.query('DELETE FROM events WHERE id = ?', [eventId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Event not found or already deleted.' });
        }

        res.json({ message: 'Event deleted successfully.' });

    } catch (err) {
        console.error('Error deleting event:', err);
        res.status(500).json({ error: 'Failed to delete event.' });
    }
});

// API Routes for Career & Alumni Network

// Job Board Endpoints
app.get('/api/jobs', authMiddleware, async (req, res) => {
    try {
        const [jobs] = await pool.query(`
            SELECT j.id, j.user_id, j.company_name, j.job_title, j.job_type, j.location, j.description, j.apply_link, j.created_at, u.username AS author_username
            FROM jobs j
            JOIN users u ON j.user_id = u.id
            ORDER BY j.created_at DESC
        `);
        res.json(jobs);
    } catch (err) {
        console.error('Error fetching jobs:', err);
        res.status(500).json({ error: 'Failed to load job opportunities.' });
    }
});

app.post('/api/jobs', authMiddleware, async (req, res) => {
    const { company_name, job_title, job_type, location, description, apply_link } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!userRoles.includes('Admin') && !userRoles.includes('Faculty') && !userRoles.includes('Alumni')) {
        return res.status(403).json({ error: 'You are not authorized to post job opportunities.' });
    }

    if (!company_name || !job_title || !job_type || !location || !description) {
        return res.status(400).json({ error: 'Please fill out all required fields.' });
    }

    try {
        await pool.query(
            'INSERT INTO jobs (user_id, company_name, job_title, job_type, location, description, apply_link) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, company_name, job_title, job_type, location, description, apply_link]
        );
        res.status(201).json({ message: 'Job opportunity posted successfully!' });
    } catch (err) {
        console.error('Error creating job posting:', err);
        res.status(500).json({ error: 'Failed to create job posting.' });
    }
});

app.delete('/api/jobs/:jobId', authMiddleware, async (req, res) => {
    const { jobId } = req.params;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    try {
        const [jobRows] = await pool.query('SELECT user_id FROM jobs WHERE id = ?', [jobId]);
        if (jobRows.length === 0) {
            return res.status(404).json({ error: 'Job posting not found.' });
        }

        if (jobRows[0].user_id !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'You are not authorized to delete this posting.' });
        }

        await pool.query('DELETE FROM jobs WHERE id = ?', [jobId]);
        res.json({ message: 'Job posting deleted successfully.' });
    } catch (err) {
        console.error('Error deleting job posting:', err);
        res.status(500).json({ error: 'Failed to delete job posting.' });
    }
});

// Alumni Network Endpoints
app.get('/api/alumni-profiles', authMiddleware, async (req, res) => {
    try {
        const [profiles] = await pool.query(`
            SELECT ap.user_id, u.name, u.username, ap.company, ap.job_title, ap.industry, ap.linkedin_url, ap.is_mentor
            FROM alumni_profiles ap
            JOIN users u ON ap.user_id = u.id
            ORDER BY u.name ASC
        `);
        res.json(profiles);
    } catch (err) {
        console.error('Error fetching alumni profiles:', err);
        res.status(500).json({ error: 'Failed to load alumni profiles.' });
    }
});

app.get('/api/alumni-profiles/me', authMiddleware, async (req, res) => {
    try {
        const [profile] = await pool.query('SELECT * FROM alumni_profiles WHERE user_id = ?', [req.session.userId]);
        if (profile.length === 0) {
            return res.status(404).json({ error: 'Profile not found.' });
        }
        res.json(profile[0]);
    } catch (err) {
        console.error('Error fetching own alumni profile:', err);
        res.status(500).json({ error: 'Failed to load your profile.' });
    }
});

app.post('/api/alumni-profiles', authMiddleware, async (req, res) => {
    const { company, job_title, industry, linkedin_url, is_mentor } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!userRoles.includes('Alumni')) {
        return res.status(403).json({ error: 'Only users with the Alumni role can create a public profile.' });
    }

    try {
        const isMentorForDb = !!is_mentor;

        const sql = `
            INSERT INTO alumni_profiles (user_id, company, job_title, industry, linkedin_url, is_mentor)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                company = VALUES(company),
                job_title = VALUES(job_title),
                industry = VALUES(industry),
                linkedin_url = VALUES(linkedin_url),
                is_mentor = VALUES(is_mentor)
        `;

        await pool.query(sql, [userId, company, job_title, industry, linkedin_url, isMentorForDb]);

        res.status(200).json({ message: 'Alumni profile updated successfully!' });
    } catch (err) {
        console.error('Error saving alumni profile:', err);
        res.status(500).json({ error: 'Failed to save alumni profile.' });
    }
});

// Endpoint to delete an alumni profile (Admin only)
app.delete('/api/alumni-profiles/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    const userId = req.params.userId;

    try {
        const [result] = await pool.query('DELETE FROM alumni_profiles WHERE user_id = ?', [userId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Alumni profile not found.' });
        }
        res.json({ message: 'Alumni profile deleted successfully.' });
    } catch (err) {
        console.error('Error deleting alumni profile:', err);
        res.status(500).json({ error: 'Failed to delete alumni profile.' });
    }
});

// API endpoint for a user to fetch their own uploaded files (for My Activities)
app.get('/api/my-files', authMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        const [files] = await pool.query(`
            SELECT
                sf.id,
                sf.file_name,
                sf.description,
                sf.drive_link,
                sf.shared_at
            FROM shared_files sf
            WHERE sf.user_id = ?
            ORDER BY sf.shared_at DESC
        `, [userId]);
        res.json(files);
    } catch (err) {
        console.error('Error fetching user files:', err);
        res.status(500).json({ error: 'Failed to load your shared files.' });
    }
});

// API endpoint for a user to fetch topics they created (for My Activities)
app.get('/api/my-topics', authMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        const [topics] = await pool.query(`
            SELECT
                t.id, t.title, t.views, t.reply_count, t.created_at, t.last_post_at,
                t.is_locked, t.is_sticky, t.upvotes, t.downvotes,
                fs.name AS section_name
            FROM topics t
            JOIN forum_sections fs ON t.section_id = fs.id
            WHERE t.user_id = ?
            ORDER BY t.created_at DESC
        `, [userId]);
        res.json(topics);
    } catch (err) {
        console.error('Error fetching user topics:', err);
        res.status(500).json({ error: 'Failed to load your topics.' });
    }
});


// NEW API endpoints for Private Posts (managed from Faculty Panel)
// Faculty/Admin creates a new private post and grants access
app.post('/api/private-posts', authMiddleware, facultyAndAdminMiddleware, async (req, res) => {
    const { title, content, recipient_ids } = req.body;
    const userId = req.session.userId;

    if (!title || !content) { // Removed recipient_ids check here, moved to HTML/JS validation
        return res.status(400).json({ error: 'Title and content are required.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [postResult] = await connection.query(
            'INSERT INTO private_posts (user_id, title, content) VALUES (?, ?, ?)',
            [userId, title, content]
        );
        const newPostId = postResult.insertId;

        // Grant access to the creator automatically
        await connection.query(
            'INSERT INTO private_post_access (private_post_id, user_id, granted_by_id) VALUES (?, ?, ?)',
            [newPostId, userId, userId] // granted_by_id is the creator themselves
        );

        // Grant access to the selected recipients
        if (Array.isArray(recipient_ids) && recipient_ids.length > 0) {
            for (const recipientId of recipient_ids) {
                try {
                    await connection.query(
                        'INSERT INTO private_post_access (private_post_id, user_id, granted_by_id) VALUES (?, ?, ?)',
                        [newPostId, recipientId, userId]
                    );
                    // Send notification and private message to each recipient
                    process.nextTick(async () => {
                        try {
                            const [userToNotify] = await pool.query('SELECT username FROM users WHERE id = ?', [recipientId]);
                            if (userToNotify.length > 0) {
                                const notificationContent = `${req.session.username} has granted you access to a private post: "${title}".`;
                                await createNotification(recipientId, 'private_post_access', newPostId, 'private_post', userId);
                                await pool.query(
                                    'INSERT INTO private_messages (sender_id, receiver_id, subject, content) VALUES (?, ?, ?, ?)',
                                    [userId, recipientId, `Access Granted: Private Post "${title}"`, notificationContent]
                                );
                            }
                        } catch (notificationErr) {
                            console.error('Error sending private post access notification (non-blocking):', notificationErr);
                        }
                    });
                } catch (dupEntryErr) {
                    if (dupEntryErr.code === 'ER_DUP_ENTRY') {
                        console.warn(`User ${recipientId} already has access to private post ${newPostId}.`);
                        continue;
                    } else {
                        throw dupEntryErr;
                    }
                }
            }
        }

        await connection.commit();
        res.status(201).json({ message: 'Private post created and access granted successfully!', privatePostId: newPostId });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error creating private post:', err);
        res.status(500).json({ error: 'Failed to create private post.' });
    } finally {
        if (connection) connection.release();
    }
});

// NEW API endpoint: Get a list of the user's own private posts (for Faculty Panel)
app.get('/api/private-posts/my', authMiddleware, facultyAndAdminMiddleware, async (req, res) => {
    const userId = req.session.userId;
    try {
        const [privatePosts] = await pool.query(`
            SELECT pp.id, pp.user_id, pp.title, pp.created_at, u.username AS author_username
            FROM private_posts pp
            JOIN users u ON pp.user_id = u.id
            WHERE pp.user_id = ?
            ORDER BY pp.created_at DESC
        `, [userId]);
        res.json(privatePosts);
    } catch (err) {
        console.error('Error fetching user\'s private posts:', err);
        res.status(500).json({ error: 'Failed to load your private posts.' });
    }
});

// NEW API endpoint: Get a single private post with its access list AND comments (for Faculty Panel)
app.get('/api/private-posts/:id', authMiddleware, facultyAndAdminMiddleware, async (req, res) => {
    const postId = req.params.id;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [postRows] = await connection.query(`
            SELECT pp.id, pp.user_id, pp.title, pp.content, pp.created_at, u.username AS author_username
            FROM private_posts pp
            JOIN users u ON pp.user_id = u.id
            WHERE pp.id = ?
        `, [postId]);

        if (postRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Private post not found.' });
        }
        const post = postRows[0];

        // Access Control: Only the author or an Admin can view (from Faculty Panel)
        if (post.user_id !== userId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to view this private post in the Faculty Panel.' });
        }

        // Fetch the list of users who have access
        const [accessUsers] = await connection.query(`
            SELECT ppa.user_id, u.username, u.name
            FROM private_post_access ppa
            JOIN users u ON ppa.user_id = u.id
            WHERE ppa.private_post_id = ?
        `, [postId]);

        // Fetch comments for the private post
        const [comments] = await connection.query(`
            SELECT ppc.id, ppc.user_id, ppc.comment_content, ppc.created_at, u.username AS commenter_username
            FROM private_post_comments ppc
            JOIN users u ON ppc.user_id = u.id
            WHERE ppc.private_post_id = ?
            ORDER BY ppc.created_at ASC
        `, [postId]);

        await connection.commit();
        res.json({ post, accessUsers, comments });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error fetching private post:', err);
        res.status(500).json({ error: 'Failed to load private post.' });
    } finally {
        if (connection) connection.release();
    }
});

// NEW API endpoint: Grant access to a private post
app.post('/api/private-posts/:id/grant-access', authMiddleware, facultyAndAdminMiddleware, async (req, res) => {
    const postId = req.params.id;
    const { user_ids } = req.body;
    const granterId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({ error: 'User IDs to grant access are required.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [postInfo] = await connection.query('SELECT user_id, title FROM private_posts WHERE id = ?', [postId]);
        if (postInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Private post not found.' });
        }
        const post = postInfo[0];

        // Authorization: Only the author or an Admin can grant access
        if (post.user_id !== granterId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to grant access to this post.' });
        }

        let grantedCount = 0;
        for (const userIdToGrant of user_ids) {
            try {
                await connection.query(
                    'INSERT INTO private_post_access (private_post_id, user_id, granted_by_id) VALUES (?, ?, ?)',
                    [postId, userIdToGrant, granterId]
                );
                grantedCount++;
            } catch (dupEntryErr) {
                if (dupEntryErr.code === 'ER_DUP_ENTRY') {
                    console.warn(`User ${userIdToGrant} already has access to private post ${postId}.`);
                    continue;
                } else {
                    throw dupEntryErr;
                }
            }
        }
        
        await connection.commit();

        if (grantedCount > 0) {
            res.status(200).json({ message: `Access granted to ${grantedCount} user(s).` });
        } else {
            res.status(400).json({ error: 'No new access was granted (users may already have access).' });
        }

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error granting private post access:', err);
        res.status(500).json({ error: 'Failed to grant access.' });
    } finally {
        if (connection) connection.release();
    }
});

// NEW API endpoint: Revoke access from a private post
app.post('/api/private-posts/:id/revoke-access', authMiddleware, facultyAndAdminMiddleware, async (req, res) => {
    const postId = req.params.id;
    const { user_id: userIdToRevoke } = req.body;
    const revokerId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!userIdToRevoke) {
        return res.status(400).json({ error: 'User ID to revoke access is required.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [postInfo] = await connection.query('SELECT user_id, title FROM private_posts WHERE id = ?', [postId]);
        if (postInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Private post not found.' });
        }
        const post = postInfo[0];
        const postOwnerId = post.user_id;

        // Authorization: Only the author or an Admin can revoke access
        if (postOwnerId !== revokerId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to revoke access for this post.' });
        }

        // Prevent revoking access from the post owner
        if (userIdToRevoke === postOwnerId) {
            await connection.rollback();
            return res.status(400).json({ error: 'Cannot revoke access from the post owner.' });
        }

        const [result] = await connection.query(
            'DELETE FROM private_post_access WHERE private_post_id = ? AND user_id = ?',
            [postId, userIdToRevoke]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'User did not have access to this post or post not found.' });
        }

        await connection.commit();
        res.status(200).json({ message: 'Access revoked successfully.' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error revoking private post access:', err);
        res.status(500).json({ error: 'Failed to revoke access.' });
    } finally {
        if (connection) connection.release();
    }
});

// NEW API endpoint: Delete a private post (and its comments)
app.delete('/api/private-posts/:id/delete', authMiddleware, facultyAndAdminMiddleware, async (req, res) => {
    const postId = req.params.id;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    try {
        const [postInfo] = await pool.query('SELECT user_id FROM private_posts WHERE id = ?', [postId]);
        if (postInfo.length === 0) {
            return res.status(404).json({ error: 'Private post not found.' });
        }
        
        const postOwnerId = postInfo[0].user_id;
        
        // Authorization: Only the author or an Admin can delete the post
        if (postOwnerId !== userId && !userRoles.includes('Admin')) {
            return res.status(403).json({ error: 'Unauthorized to delete this private post.' });
        }

        // Delete the post and all associated access records and comments due to ON DELETE CASCADE
        const [result] = await pool.query('DELETE FROM private_posts WHERE id = ?', [postId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Private post not found or already deleted.' });
        }

        res.json({ message: 'Private post deleted successfully.' });

    } catch (err) {
        console.error('Error deleting private post:', err);
        res.status(500).json({ error: 'Failed to delete private post.' });
    }
});


// NEW API endpoint: Add a comment to a private post
app.post('/api/private-posts/:id/comments', authMiddleware, async (req, res) => {
    const postId = req.params.id;
    const { comment_content } = req.body;
    const userId = req.session.userId;
    const userRoles = req.session.roles || [];

    if (!comment_content || comment_content.trim() === '') {
        return res.status(400).json({ error: 'Comment content cannot be empty.' });
    }

    try {
        // First, check if the user has access to this private post
        const [postInfo] = await pool.query('SELECT user_id FROM private_posts WHERE id = ?', [postId]);
        if (postInfo.length === 0) {
            return res.status(404).json({ error: 'Private post not found.' });
        }
        const postOwnerId = postInfo[0].user_id;

        // User must be the post owner, an Admin, or a user granted access
        if (postOwnerId !== userId && !userRoles.includes('Admin')) {
            const [accessCheck] = await pool.query(
                'SELECT COUNT(*) AS count FROM private_post_access WHERE private_post_id = ? AND user_id = ?',
                [postId, userId]
            );
            if (accessCheck[0].count === 0) {
                return res.status(403).json({ error: 'Access denied. You do not have permission to comment on this private post.' });
            }
        }

        // Insert the comment
        await pool.query(
            'INSERT INTO private_post_comments (private_post_id, user_id, comment_content) VALUES (?, ?, ?)',
            [postId, userId, comment_content]
        );

        // Notify the private post owner about the new comment (if not the commenter)
        if (postOwnerId !== userId) {
            await createNotification(postOwnerId, 'new_private_post_comment', postId, 'private_post', userId);
        }
        // Also notify other users who have access to this private post about the new comment
        const [otherAccessUsers] = await pool.query(`
            SELECT ppa.user_id FROM private_post_access ppa
            WHERE ppa.private_post_id = ? AND ppa.user_id != ? AND ppa.user_id != ?
        `, [postId, postOwnerId, userId]);

        for (const user of otherAccessUsers) {
            await createNotification(user.user_id, 'new_private_post_comment', postId, 'private_post', userId);
        }


        res.status(201).json({ message: 'Comment added successfully!' });

    } catch (err) {
        console.error('Error adding comment to private post:', err);
        res.status(500).json({ error: 'Failed to add comment.' });
    }
});


// Google OAuth2 configuration
const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Google Drive File Sharing Endpoints
app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/drive.file'
    ];
    const authorizationUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        include_granted_scopes: true
    });
    res.redirect(authorizationUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        req.session.googleTokens = tokens;
        console.log("Google tokens acquired:", tokens);
        res.redirect('/filesharing');
    } catch (error) {
        console.error('Error retrieving access token', error);
        res.status(500).send('Authentication failed.');
    }
});

app.post('/api/drive/upload', authMiddleware, async (req, res) => {
    if (!req.session.googleTokens) {
        return res.status(401).json({ error: 'Google Drive not authenticated. Please connect your Google account.' });
    }

    oAuth2Client.setCredentials(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    const { fileName, fileContentBase64, mimeType, description } = req.body;

    if (!fileName || !fileContentBase64 || !mimeType) {
        return res.status(400).json({ error: 'File name, content, and MIME type are required.' });
    }

    const fileBuffer = Buffer.from(fileContentBase64, 'base64');
    const readableStream = new Readable();
    readableStream.push(fileBuffer);
    readableStream.push(null);

    try {
        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                mimeType: mimeType,
                description: description || 'File shared via UIU Connect',
            },
            media: {
                mimeType: mimeType,
                body: readableStream,
            },
            fields: 'id, name, webViewLink, webContentLink',
        });

        const fileId = response.data.id;

        await pool.query(
            'INSERT INTO shared_files (user_id, google_drive_file_id, file_name, file_mime_type, drive_link, description) VALUES (?, ?, ?, ?, ?, ?)',
            [req.session.userId, fileId, fileName, mimeType, response.data.webViewLink, description]
        );

        res.json({
            message: 'File uploaded successfully to Google Drive and shared!',
            file: {
                id: fileId,
                name: response.data.name,
                webViewLink: response.data.webViewLink,
                webContentLink: response.data.webContentLink
            }
        });
    } catch (error) {
        console.error('Error uploading file to Google Drive:', error.message);
        if (error.code === 401 || error.code === 403) {
            return res.status(401).json({ error: 'Google Drive authentication expired or invalid. Please reconnect your Google account.' });
        }
        res.status(500).json({ error: 'Failed to upload file to Google Drive: ' + error.message });
    }
});

app.get('/api/shared-files', authMiddleware, async (req, res) => {
    const currentUserId = req.session.userId;

    try {
        const [files] = await pool.query(`
            SELECT
                sf.id,
                sf.file_name,
                sf.description,
                sf.drive_link,
                sf.shared_at,
                u.username AS shared_by,
                u.id AS shared_by_user_id,
                FAR.status AS access_request_status
            FROM shared_files sf
            JOIN users u ON sf.user_id = u.id
            LEFT JOIN file_access_requests FAR ON sf.id = FAR.file_id AND FAR.requester_user_id = ?
            ORDER BY sf.shared_at DESC
        `, [currentUserId]);

        res.json(files);
    } catch (err) {
        console.error('Error fetching shared files:', err);
        res.status(500).json({ error: 'Failed to load shared files.' });
    }
});

app.post('/api/shared-files/:fileId/request-access', authMiddleware, async (req, res) => {
    const fileId = req.params.fileId;
    const requesterUserId = req.session.userId;
    const requesterUsername = req.session.username;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [fileInfo] = await connection.query(
            'SELECT sf.user_id AS uploader_id, sf.file_name, u.username AS uploader_username FROM shared_files sf JOIN users u ON sf.user_id = u.id WHERE sf.id = ?',
            [fileId]
        );

        if (fileInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'File not found.' });
        }

        const { uploader_id, file_name, uploader_username } = fileInfo[0];

        if (requesterUserId === uploader_id) {
            await connection.rollback();
            return res.status(400).json({ error: 'You own this file. No access request needed.' });
        }

        const [existingRequest] = await connection.query(
            'SELECT status FROM file_access_requests WHERE file_id = ? AND requester_user_id = ?',
            [fileId, requesterUserId]
        );

        if (existingRequest.length > 0) {
            await connection.rollback();
            return res.status(409).json({ error: `You have already ${existingRequest[0].status} request for this file.` });
        }

        await connection.query(
            'INSERT INTO file_access_requests (file_id, requester_user_id, status) VALUES (?, ?, ?)',
            [fileId, requesterUserId, 'pending']
        );

        const pmSubject = `File Access Request: "${file_name}" by ${requesterUsername}`;
        const pmContent = `Hello ${uploader_username},\n\n${requesterUsername} (${req.session.name}) has requested access to your shared file: "${file_name}".\n\nTo review this request and potentially grant access, please respond to this message and share the file directly with them via Google Drive.\n\nThank you.`;

        await connection.query(
            'INSERT INTO private_messages (sender_id, receiver_id, subject, content) VALUES (?, ?, ?, ?)',
            [requesterUserId, uploader_id, pmSubject, pmContent]
        );

        await connection.commit();
        res.json({ message: 'Access request sent successfully to the file uploader via private message.' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error processing file access request:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'You have already submitted an access request for this file.' });
        }
        res.status(500).json({ error: 'Failed to send file access request.' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/api/incoming-file-access-requests', authMiddleware, async (req, res) => {
    const userId = req.session.userId;

    try {
        const [requests] = await pool.query(`
            SELECT
                FAR.id,
                FAR.file_id,
                FAR.requester_user_id,
                FAR.status,
                FAR.requested_at,
                SF.file_name,
                SF.google_drive_file_id,
                SF.drive_link,
                RU.username AS requester_username,
                RU.email AS requester_email
            FROM file_access_requests FAR
            JOIN shared_files SF ON FAR.file_id = SF.id
            JOIN users RU ON FAR.requester_user_id = RU.id
            WHERE SF.user_id = ?
            ORDER BY FAR.requested_at DESC
        `, [userId]);

        res.json(requests);
    } catch (err) {
        console.error('Error fetching incoming file access requests:', err);
        res.status(500).json({ error: 'Failed to load incoming access requests.' });
    }
});

app.post('/api/file-access-requests/:requestId/respond', authMiddleware, async (req, res) => {
    const requestId = req.params.requestId;
    const { action } = req.body;
    const userId = req.session.userId;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [requestInfo] = await connection.query(`
            SELECT
                FAR.id,
                FAR.file_id,
                FAR.requester_user_id,
                FAR.status,
                SF.user_id AS file_owner_id,
                SF.google_drive_file_id,
                SF.file_name,
                SF.drive_link,
                RU.email AS requester_email,
                RU.username AS requester_username
            FROM file_access_requests FAR
            JOIN shared_files SF ON FAR.file_id = SF.id
            JOIN users RU ON FAR.requester_user_id = RU.id
            WHERE FAR.id = ?
        `, [requestId]);

        if (requestInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Access request not found.' });
        }

        const request = requestInfo[0];

        if (request.file_owner_id !== userId) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to respond to this access request.' });
        }

        if (request.status !== 'pending') {
            await connection.rollback();
            return res.status(400).json({ error: `Request already ${request.status}.` });
        }

        if (action === 'approve') {
            // Ensure googleTokens are available for the owner to grant access
            if (!req.session.googleTokens) {
                await connection.rollback();
                return res.status(401).json({ error: 'Google Drive not authenticated for file owner. Cannot grant access.' });
            }

            oAuth2Client.setCredentials(req.session.googleTokens);
            const drive = google.drive({ version: 'v3', auth: oAuth2Client });

            try {
                await drive.permissions.create({
                    fileId: request.google_drive_file_id,
                    requestBody: {
                        role: 'reader',
                        type: 'user',
                        emailAddress: request.requester_email
                    },
                    fields: 'id'
                });
                console.log(`Granted read permission for ${request.requester_email} to Google Drive file ${request.file_name}.`);

            } catch (driveErr) {
                await connection.rollback();
                console.error('Error granting Google Drive permission:', driveErr.message);
                if (driveErr.errors && driveErr.errors[0].reason === 'notFound') {
                    return res.status(500).json({ error: 'Failed to grant access: Google Drive file not found or inaccessible.' });
                }
                return res.status(500).json({ error: 'Failed to grant access via Google Drive. Check Drive permissions or try manually.' });
            }

            await connection.query(
                'UPDATE file_access_requests SET status = ?, responded_at = NOW(), respondent_user_id = ? WHERE id = ?',
                ['approved', userId, requestId]
            );

            const pmSubject = `Access Granted: "${request.file_name}"`;
            const pmContent = `Hello ${request.requester_username},\n\nYour request for access to "${request.file_name}" has been approved by the uploader. You should now be able to view it via this link: ${request.drive_link}\n\nThank you.`;
            await connection.query(
                'INSERT INTO private_messages (sender_id, receiver_id, subject, content) VALUES (?, ?, ?, ?)',
                [userId, request.requester_user_id, pmSubject, pmContent]
            );

            await connection.commit();
            res.json({ message: 'File access approved and permission granted.' });

        } else if (action === 'reject') {
            await connection.query(
                'UPDATE file_access_requests SET status = ?, responded_at = NOW(), respondent_user_id = ? WHERE id = ?',
                ['rejected', userId, requestId]
            );

            const pmSubject = `Access Denied: "${request.file_name}"`;
            const pmContent = `Hello ${request.requester_username},\n\nYour request for access to "${request.file_name}" has been rejected by the uploader.\n\nThank you.`;
            await connection.query(
                'INSERT INTO private_messages (sender_id, receiver_id, subject, content) VALUES (?, ?, ?, ?)',
                [userId, request.requester_user_id, pmSubject, pmContent]
            );

            await connection.commit();
            res.json({ message: 'File access request rejected.' });
        } else {
            await connection.rollback();
            return res.status(400).json({ error: 'Invalid action. Must be "approve" or "reject".' });
        }

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error responding to file access request:', err);
        res.status(500).json({ error: 'Failed to respond to access request.' });
    } finally {
        if (connection) connection.release();
    }
});

app.delete('/api/shared-files/:fileId', authMiddleware, async (req, res) => {
    const fileId = req.params.fileId;
    const userId = req.session.userId;
    const userRoles = req.session.roles;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [fileInfo] = await connection.query('SELECT user_id, google_drive_file_id FROM shared_files WHERE id = ?', [fileId]);

        if (fileInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Shared file not found in database.' });
        }

        const sharedFile = fileInfo[0];

        // Allow Admin or the file owner to delete the file
        if (sharedFile.user_id !== userId && !userRoles.includes('Admin')) {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized to delete this shared file.' });
        }
        
        // Attempt to delete from Google Drive if a file ID is recorded and owner is authenticated with Drive
        if (sharedFile.google_drive_file_id && req.session.googleTokens) {
            oAuth2Client.setCredentials(req.session.googleTokens);
            const drive = google.drive({ version: 'v3', auth: oAuth2Client });
            try {
                await drive.files.delete({ fileId: sharedFile.google_drive_file_id });
                console.log(`Successfully deleted file ${sharedFile.google_drive_file_id} from Google Drive.`);
            } catch (driveErr) {
                console.warn(`Could not delete file ${sharedFile.google_drive_file_id} from Google Drive (might already be deleted or permission issue):`, driveErr.message);
                // Continue with database deletion even if Drive deletion fails
            }
        }

        const [result] = await connection.query('DELETE FROM shared_files WHERE id = ?', [fileId]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Shared file not found or already deleted from database.' });
        }

        await connection.commit();
        res.json({ message: 'Shared file deleted successfully.' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error deleting shared file:', err);
        res.status(500).json({ error: 'Failed to delete shared file.' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/filesharing', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'filesharing.html')));

// Start the Server
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));