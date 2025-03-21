const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Add this line
const { bookTherapyAppointment } = require('./main.js');
const AppointmentStatus = require('./models/AppointmentStatus');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors()); // Add this line before other middleware

// MongoDB connection
mongoose.connect('mongodb+srv://hayim:b7ygfCTUCQeuysw7@cluster0.obhkx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Middleware
app.use(express.json());

// API Routes
app.get('/api/appointments', async (req, res) => {
    try {
        const appointments = await AppointmentStatus.find()
            .sort({ createdAt: -1 })
            .select('-__v'); // Exclude version key
        res.json(appointments);
    } catch (error) {
        console.error('Error fetching appointments:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Queue processing flag
let isProcessing = false;

// Modified booking function to accept appointment details
async function bookAppointment(appointmentDetails) {
    try {
        const result = await bookTherapyAppointment(
            appointmentDetails.href,
            {
                firstName: appointmentDetails.firstName,
                lastName: appointmentDetails.lastName,
                email: appointmentDetails.email,
                phone: appointmentDetails.phone,
                dateOfBirth: appointmentDetails.dateOfBirth,
                comments: appointmentDetails.comments
            }
        );
        
        // Update the appointment status based on the result
        await AppointmentStatus.findByIdAndUpdate(
            appointmentDetails._id,
            { 
                status: result.status === 'success' ? 'booked' : 'unknown',
                lastError: result.error || null,
                lastAttempt: new Date()
            }
        );

        return result.status;
    } catch (error) {
        console.error('Error booking appointment:', error);    
        return 'failed';
    }
}

// Process queue function
async function processQueue() {
    if (isProcessing) return;
    
    try {
        isProcessing = true;
        
        // Get all unknown appointments
        const unknownAppointments = await AppointmentStatus.find({ status: 'unknown' });
        
        if (unknownAppointments.length > 0) {
            console.log(`Found ${unknownAppointments.length} appointments to process`);
            
            // Process all appointments sequentially
            for (const appointment of unknownAppointments) {
                console.log(`Processing appointment for ${appointment.firstName}`);
                const status = await bookAppointment(appointment);
                console.log(`Appointment processing completed with status: ${status}`);
            }
        }
    } catch (error) {
        console.error('Error processing queue:', error);
    } finally {
        isProcessing = false;
    }
}

// Modified route to trigger queue processing
app.get('/api/appointments/unknown', async (req, res) => {
    try {
        const appointments = await AppointmentStatus.find({ status: 'unknown' })
            .sort({ createdAt: -1 })
            .select('-__v');
        
        // Trigger queue processing
        processQueue();
        
        res.json(appointments);
    } catch (error) {
        console.error('Error fetching unknown appointments:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});