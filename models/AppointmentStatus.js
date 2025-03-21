const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * AppointmentStatus Model
 * Enhanced model to track appointment bookings with all form fields
 */
const AppointmentStatusSchema = new Schema({
    // User information - Basic
    firstName: {
        type: String,
        required: true
    },
    middleName: {
        type: String,
    },
    lastName: {
        type: String,
        required: true
    },
    preferredName: {
        type: String,
    },
    dateOfBirth: {
        type: String,
        required: true
    },
    phone: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    
    // Appointment information
    href: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    clinicianId: {
        type: String,
        required: true,
        index: true
    },
    clinicianName: {
        type: String,
    },
    appointmentType: {
        type: String,
    },
    appointmentDate: {
        type: String
    },
    appointmentTime: {
        type: String
    },
    
    // Status
    status: {
        type: String,
        enum: ['unknown', 'booked','expired'],
        default: 'unknown',
        index: true
    },
    
    // Insurance information
    insurance: {
        type: String,
        required: false
    },
    memberId: {  // Make sure this field exists
        type: String,
        required: false // Change this to false
    },
    fileUrls: [{  // Make sure this field exists
        type: String
    }],
    
    // Mental health information
    previousTherapy: {
        type: String,
        enum: ['yes', 'no'],
        required: true
    },
    takingMedication: {
        type: String,
        enum: ['yes', 'no'],
        required: true
    },
    mentalHealthDiagnosis: {
        type: String
    },
    reasonForTherapy: {
        type: String,
        required: true
    },
    hasMedicationHistory: {
        type: String,
        enum: ['yes', 'no'],
        required: true
    },
    medicationHistory: {
        type: String,
        required: false
    },
    
    // Additional notes/comments
    comments: {
        type: String
    },
    
    // Tracking fields
    submittedAt: {
        type: Date,
        default: Date.now
    },
    processingLog: [{
        status: String,
        timestamp: Date,
        message: String
    }]
}, {
    timestamps: true
});

// Create indexes
AppointmentStatusSchema.index({ clinicianId: 1, status: 1 });
AppointmentStatusSchema.index({ email: 1 });
AppointmentStatusSchema.index({ phone: 1 });
AppointmentStatusSchema.index({ appointmentDate: 1, appointmentTime: 1 });

module.exports = mongoose.model('AppointmentStatus', AppointmentStatusSchema);