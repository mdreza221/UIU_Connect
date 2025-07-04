// public/notifications.js

// This script handles real-time (via polling) notifications for the UIU Connect platform.
// It displays a notification badge in the navbar and a dropdown list of unread notifications.

// Ensure the DOM is fully loaded before trying to access elements.
document.addEventListener('DOMContentLoaded', () => {
    // Get references to key DOM elements for notifications
    const notificationBell = document.getElementById('notificationBell');
    const notificationBadge = document.getElementById('notificationBadge');
    const notificationsDropdown = document.getElementById('notificationsDropdown');
    const notificationsList = document.getElementById('notificationsList');
    const markAllReadBtn = document.getElementById('markAllReadBtn');

    let hasUnreadNotifications = false; // Flag to track if there are any unread notifications

    // Check if the notification bell element exists (it should only exist if the user is authenticated)
    if (notificationBell) {
        // Add a click listener to the bell icon to toggle the notification dropdown visibility
        notificationBell.addEventListener('click', async (event) => {
            // Prevent the click from propagating and immediately closing the dropdown via document click
            event.stopPropagation();
            const isActive = notificationsDropdown.classList.toggle('active'); // Toggle 'active' class to show/hide dropdown
            if (isActive) { // If the dropdown is now active (visible)
                await fetchNotifications(); // Fetch and display the latest notifications
            }
        });

        // Add a click listener to the entire document to close the dropdown if clicked outside
        document.addEventListener('click', (event) => {
            // Check if the click occurred outside of the bell and outside of the dropdown itself
            if (notificationsDropdown && !notificationBell.contains(event.target) && !notificationsDropdown.contains(event.target)) {
                notificationsDropdown.classList.remove('active'); // Hide the dropdown
            }
        });
    }

    // Function to fetch notifications from the server and update the UI
    async function fetchNotifications() {
        // Exit if the notifications list element is not found on the page
        if (!notificationsList) return;

        // Display a loading message while fetching notifications
        notificationsList.innerHTML = '<p class="no-notifications">Loading notifications...</p>';
        markAllReadBtn.style.display = 'none'; // Hide "Mark All Read" button during loading
        notificationBadge.style.display = 'none'; // Hide the badge during loading
        hasUnreadNotifications = false; // Reset the unread flag

        try {
            // Make an asynchronous API call to fetch notifications
            const res = await fetch('/api/notifications');
            const notifications = await res.json(); // Parse the JSON response from the server

            if (res.ok) { // Check if the HTTP response status is OK (200-299)
                notificationsList.innerHTML = ''; // Clear the loading message from the list
                if (notifications.length === 0) { // If no notifications are returned from the API
                    notificationsList.innerHTML = '<p class="no-notifications">No new notifications.</p>';
                } else { // If notifications are available
                    // Iterate over each notification received
                    notifications.forEach(notif => {
                        const notifItem = document.createElement('div'); // Create a div element for each notification
                        notifItem.classList.add('notification-item');
                        if (!notif.is_read) { // Check if the notification is marked as unread
                            notifItem.classList.add('unread'); // Add CSS class for unread styling
                            hasUnreadNotifications = true; // Set flag as there's at least one unread notification
                        }

                        let notificationText = ''; // Variable to store the formatted notification message
                        let notificationLink = ''; // Variable to store the URL to navigate to

                        // Determine the notification message and link based on its 'type'
                        switch (notif.type) {
                            case 'new_message':
                                notificationText = `New message from ${notif.sender_username}: "${notif.message_subject}"`;
                                notificationLink = '/inbox'; // Link to the user's inbox
                                break;
                            case 'new_topic_reply':
                                notificationText = `${notif.sender_username} replied to your topic: "${notif.topic_title}"`;
                                notificationLink = `/forum/topics/${notif.entity_id}`; // Link directly to the topic page
                                break;
                            case 'new_post_reply':
                                // This notification type is for replies to posts a user has participated in (but not necessarily owns the topic)
                                notificationText = `${notif.sender_username} replied in a topic you posted in.`;
                                if (notif.topic_id_for_post_reply) { // If the backend provided the topic ID for this post reply
                                    // Link to the specific post within the topic for better context
                                    notificationLink = `/forum/topics/${notif.topic_id_for_post_reply}#post-${notif.entity_id}`;
                                } else {
                                    notificationLink = `/forum`; // Fallback to the general forum page if topic ID is missing
                                }
                                break;
                            default:
                                notificationText = `New notification: ${notif.type}`;
                                notificationLink = '#'; // Default fallback link if type is unknown
                        }

                        // Populate the inner HTML of the notification item
                        notifItem.innerHTML = `
                            <div class="notification-content">${notificationText}</div>
                            <div class="notification-meta">
                                <span>${formatRelativeTime(notif.created_at)}</span>
                                <span style="font-style: italic;">${notif.is_read ? 'Read' : 'Unread'}</span>
                            </div>
                        `;

                        // Add a click event listener to each notification item
                        notifItem.addEventListener('click', async () => {
                            if (!notif.is_read) { // If the notification is currently unread
                                await markNotificationAsRead(notif.id); // Mark it as read on the server
                            }
                            if (notificationLink && notificationLink !== '#') { // If a valid navigation link exists
                                window.location.href = notificationLink; // Navigate the user to the link
                            }
                        });
                        notificationsList.appendChild(notifItem); // Add the constructed notification item to the list in the dropdown
                    });

                    // Update the visibility and content of the notification badge and "Mark All Read" button
                    if (hasUnreadNotifications) {
                        notificationBadge.style.display = 'block'; // Show the notification badge
                        // Set the badge text content to the number of currently unread notifications
                        notificationBadge.textContent = notifications.filter(n => !n.is_read).length;
                        markAllReadBtn.style.display = 'block'; // Show the "Mark All As Read" button
                    } else {
                        notificationBadge.style.display = 'none'; // Hide the badge if no unread notifications
                        markAllReadBtn.style.display = 'none'; // Hide the button if no unread notifications
                    }

                }
            } else { // If the API call itself failed (e.g., server error, not res.ok)
                // Display an error message in the notification list
                notificationsList.innerHTML = `<p class="no-notifications error">${notifications.error || 'Failed to load notifications.'}</p>`;
                notificationBadge.style.display = 'none'; // Ensure badge is hidden on error
            }
        } catch (error) { // Catch any network errors during the fetch operation
            console.error('Error fetching notifications:', error);
            notificationsList.innerHTML = '<p class="no-notifications error">Network error fetching notifications.</p>';
            notificationBadge.style.display = 'none'; // Ensure badge is hidden on network error
        }
    }

    // Function to send a request to the server to mark a specific notification as read
    async function markNotificationAsRead(notificationId) {
        try {
            const res = await fetch(`/api/notifications/${notificationId}/read`, {
                method: 'POST', // Use POST method to update the resource state
                headers: { 'Content-Type': 'application/json' }, // Specify content type
            });
            if (res.ok) { // If the request was successful
                // Re-fetch all notifications to ensure the UI is up-to-date (badge count, item status)
                await fetchNotifications();
            } else {
                const data = await res.json(); // Parse the error response
                console.error('Error marking notification as read:', data.error);
            }
        } catch (err) { // Catch network errors for the mark-as-read request
            console.error('Network error marking notification as read:', err);
        }
    }

    // Add event listener for the "Mark All As Read" button
    if (markAllReadBtn) { // Ensure the button element exists on the page
        markAllReadBtn.addEventListener('click', async () => {
            // Confirm with the user before marking all notifications as read
            if (confirm('Are you sure you want to mark all notifications as read?')) {
                try {
                    // Send a POST request to the API to mark all notifications for the current user as read
                    const res = await fetch('/api/notifications/mark-all-read', { method: 'POST' });
                    if (res.ok) { // If the request was successful
                        alert('All notifications marked as read.');
                        await fetchNotifications(); // Re-fetch to update the UI
                    } else {
                        const data = await res.json(); // Parse the error response
                        alert('Error marking all notifications as read: ' + (data.error || 'Failed.'));
                    }
                } catch (err) { // Catch network errors for the mark-all-read request
                    console.error('Network error marking all notifications as read:', err);
                    alert('Network error or server unavailable.');
                }
            }
        });
    }

    // Helper function to format a timestamp into a human-readable relative time string (e.g., "5m ago")
    function formatRelativeTime(timestamp) {
        const date = new Date(timestamp); // Convert the timestamp to a Date object
        const now = new Date(); // Get the current date and time
        const diffMs = now - date; // Calculate the difference in milliseconds
        const diffSec = Math.round(diffMs / 1000); // Difference in seconds
        const diffMin = Math.round(diffSec / 60); // Difference in minutes
        const diffHr = Math.round(diffMin / 60); // Difference in hours
        const diffDay = Math.round(diffHr / 24); // Difference in days

        if (diffSec < 60) return `${diffSec}s ago`; // Less than 1 minute
        if (diffMin < 60) return `${diffMin}m ago`; // Less than 1 hour
        if (diffHr < 24) return `${diffHr}h ago`; // Less than 1 day
        if (diffDay < 30) return `${diffDay}d ago`; // Less than 30 days
        return date.toLocaleDateString(); // For older notifications, display the full date
    }

    // Initial fetch of notifications when the page first loads, and then set up periodic polling
    if (notificationBell) { // Only execute this block if the notification bell element is present (user is authenticated)
        fetchNotifications(); // Call fetchNotifications immediately on page load
        setInterval(fetchNotifications, 30000); // Set up polling to fetch new notifications every 30 seconds
    }
});