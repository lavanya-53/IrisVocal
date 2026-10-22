package com.irisvocal.irisvocal_backend.Dto;

import com.irisvocal.irisvocal_backend.Enums.EmergencyStatus;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class EmergencyResponse {
   private boolean success;
   private EmergencyStatus status;
   private String message;
   private String locationUrl;
}
